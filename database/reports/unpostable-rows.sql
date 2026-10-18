-- unpostable-rows.sql — read-only report: data-store rows nothing can be posted from (2026-10-18).
--
--   psql "$DATABASE_URL" -f database/reports/unpostable-rows.sql
--
-- Runs in a READ ONLY transaction and rolls back; changes nothing. Works before and after migration 083.
--
--   1. prompts by provider: rows, rows ever published, and why rows cannot be posted
--      (page_url a gallery / empty, no prompt_text and no media_url), plus how many 083 can repair
--      from their own prompt_source / id fields;
--   2. every dataset with a post_requires rule (083+): active rows that miss it.

BEGIN READ ONLY;

\echo '1. prompts by provider'
WITH p AS (
  SELECT d.id, d.status, d.legacy_ref, d.data,
         d.data->>'provider' AS provider,
         COALESCE(d.data->>'page_url', '')                          AS page_url,
         COALESCE(d.data->>'page_url', '') ~* '^https?://(www\.)?prompthero\.com/prompt/[^/?#]+' AS page_single,
         COALESCE(d.data->>'prompt_source', '') ~* '^https?://(www\.)?prompthero\.com/prompt/[^/?#]+' AS source_single,
         COALESCE(d.data->>'id', '') ~* '^https?://(cdn\.prompthero\.com/|(www\.)?prompthero\.com/_next/image)' AS id_image,
         btrim(COALESCE(d.data->>'prompt_text', '')) <> ''           AS has_text,
         btrim(COALESCE(d.data->>'media_url', '')) <> ''             AS has_media
    FROM data_items d JOIN data_schemas s ON s.id = d.schema_id
   WHERE s.key = 'prompts' AND d.status = 'active'
), u AS (
  SELECT p.*,
         EXISTS (SELECT 1 FROM content_ledger l
                  WHERE l.status = 'published'
                    AND l.source_ref IN ('data://prompts/' || p.id, p.legacy_ref)) AS published,
         (CASE WHEN p.provider = 'prompthero' THEN NOT p.page_single ELSE p.page_url = '' END)
           OR NOT (p.has_text OR p.has_media)                                      AS unusable
    FROM p
)
SELECT provider,
       count(*)                                                                    AS rows,
       count(*) FILTER (WHERE published)                                           AS published,
       count(*) FILTER (WHERE NOT published)                                       AS never_published,
       count(*) FILTER (WHERE page_url <> '' AND provider = 'prompthero' AND NOT page_single) AS page_url_gallery,
       count(*) FILTER (WHERE page_url = '')                                       AS page_url_empty,
       count(*) FILTER (WHERE NOT has_text AND NOT has_media)                      AS no_text_no_media,
       count(*) FILTER (WHERE unusable)                                            AS unusable,
       count(*) FILTER (WHERE unusable AND NOT published)                          AS unusable_never_published,
       count(*) FILTER (WHERE unusable AND provider = 'prompthero' AND source_single AND (has_text OR has_media OR id_image))
                                                                                   AS repairable_by_083,
       max(data->>'scraped_at')                                                    AS last_scraped
  FROM u
 GROUP BY provider
 ORDER BY rows DESC;

\echo '2. datasets with a post_requires rule (migration 083+): active rows that miss it'
SELECT to_regprocedure('data_postable(jsonb,jsonb)') IS NOT NULL AS has_083 \gset
\if :has_083
SELECT s.key AS dataset, s.post_requires,
       count(d.*) AS active_rows,
       count(d.*) FILTER (WHERE NOT data_postable(s.post_requires, d.data)) AS not_postable,
       (SELECT array_agg(m ORDER BY m) FROM (SELECT DISTINCT unnest(data_post_missing(s.post_requires, x.data)) AS m
                                               FROM data_items x WHERE x.schema_id = s.id AND x.status = 'active') z) AS missing
  FROM data_schemas s LEFT JOIN data_items d ON d.schema_id = s.id AND d.status = 'active'
 WHERE s.post_requires IS DISTINCT FROM '[]'::jsonb
 GROUP BY s.id, s.key, s.post_requires
 ORDER BY s.key;
\else
\echo '   migration 083 not applied yet: no post_requires rules'
\endif

ROLLBACK;
