-- 083_post_requires.sql — a dataset says which fields a row needs before it can be posted (2026-10-18).
--
-- Seen in the owner's chat with @ai0_prompts_dev: the catalog reported 4 764 unused `prompts` rows, but every
-- unused PromptHero row had the gallery page (prompthero.com/flux-prompts …) in page_url and no media_url,
-- title or prompt_text. The pipeline loader had put the gallery the scraper visited into page_url, the
-- single-prompt link into the hidden prompt_source field and the image only into the hidden id.
--
--   data_schemas.post_requires  groups of field names; a row can be posted when every group has at least
--                               one filled field. prompts: [["page_url"], ["prompt_text", "media_url"]].
--   data_value_present() / data_postable() / data_post_missing()   the rule, one definition for SQL and TS
--   data_items_upsert()         new rows that miss a group are invalid ("required for posting: …")
--   data_schema_stats           unposted_network counts only postable rows; rows_unpostable is new
--   repair                      PromptHero rows get page_url from prompt_source (a /prompt/ link) and
--                               media_url from id (the image URL); a gallery page_url that cannot be
--                               repaired is cleared. Recorded as a data_imports row with snapshots, so the
--                               dashboard undo restores the old values.
--
-- Additive and idempotent (CI re-applies it): the repair touches only rows that still need it.

-- ─── The rule ────────────────────────────────────────────────────────────────

ALTER TABLE data_schemas ADD COLUMN IF NOT EXISTS post_requires JSONB NOT NULL DEFAULT '[]';
ALTER TABLE data_schema_stats ADD COLUMN IF NOT EXISTS rows_unpostable BIGINT NOT NULL DEFAULT 0;

-- A value counts as filled unless it is missing, JSON null, blank text, [] or {} (the is_null filter's notion).
CREATE OR REPLACE FUNCTION data_value_present(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT v IS NOT NULL AND CASE jsonb_typeof(v)
    WHEN 'null'   THEN false
    WHEN 'string' THEN btrim(v #>> '{}') <> ''
    WHEN 'array'  THEN jsonb_array_length(v) > 0
    WHEN 'object' THEN v <> '{}'::jsonb
    ELSE true
  END
$$;

-- One group of post_requires as a list of field names (a bare string is a group of one).
CREATE OR REPLACE FUNCTION data_post_group(g jsonb) RETURNS SETOF text
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(g) = 'array' THEN g ELSE jsonb_build_array(g) END)
$$;

CREATE OR REPLACE FUNCTION data_postable(p_requires jsonb, p_data jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(p_requires) IS DISTINCT FROM 'array' OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_requires) g
     WHERE NOT EXISTS (SELECT 1 FROM data_post_group(g) f WHERE data_value_present(p_data->f)))
$$;

-- The groups a row misses, each as "a or b" (empty when the row can be posted).
CREATE OR REPLACE FUNCTION data_post_missing(p_requires jsonb, p_data jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(array_agg((SELECT string_agg(f, ' or ') FROM data_post_group(g) f) ORDER BY n), '{}')
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_requires) = 'array' THEN p_requires ELSE '[]'::jsonb END)
         WITH ORDINALITY e(g, n)
   WHERE NOT EXISTS (SELECT 1 FROM data_post_group(g) f WHERE data_value_present(p_data->f))
$$;

-- post_requires must be a list of non-empty groups of the dataset's own field names.
CREATE OR REPLACE FUNCTION data_post_requires_valid(p_requires jsonb, p_fields jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(p_requires) = 'array'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_requires) g
        WHERE jsonb_typeof(g) NOT IN ('array', 'string')
           OR (jsonb_typeof(g) = 'array' AND jsonb_array_length(g) = 0)
           OR EXISTS (SELECT 1 FROM data_post_group(g) f
                       WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_fields) x WHERE x->>'name' = f)))
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'data_schemas_post_requires_check') THEN
    ALTER TABLE data_schemas ADD CONSTRAINT data_schemas_post_requires_check
      CHECK (data_post_requires_valid(post_requires, fields));
  END IF;
END $$;

-- ─── The write path: new rows must be postable ───────────────────────────────
-- Same as 058, plus one check on insert (marked 083). Merges into existing rows are not blocked: the
-- catalog and query_data skip rows that are not postable.
CREATE OR REPLACE FUNCTION data_items_upsert(
  p_schema_key    text,
  p_rows          jsonb,
  p_import_id     uuid   DEFAULT NULL,
  p_update_fields text[] DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  s         data_schemas%ROWTYPE;
  r         jsonb;
  n         bigint;
  p         record;
  f         jsonb;
  v_names   text[];
  v_defs    jsonb;
  v_prefix  text;
  v_ref     text;
  v_key     text;
  v_new     jsonb;
  v_patch   jsonb;
  v_errs    jsonb;
  v_item    data_items%ROWTYPE;
  v_id      bigint;
  v_miss    text[];
  ins int := 0; upd int := 0; skp int := 0; nbad int := 0;
  bad jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO s FROM data_schemas WHERE key = p_schema_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'data_items_upsert: unknown data schema "%"', p_schema_key USING ERRCODE = 'no_data_found'; END IF;
  IF s.status = 'archived' THEN RAISE EXCEPTION 'data_items_upsert: data schema "%" is archived', p_schema_key; END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN RAISE EXCEPTION 'data_items_upsert: rows must be a JSON array'; END IF;

  SELECT array_agg(e->>'name'), COALESCE(jsonb_object_agg(e->>'name', e->'default') FILTER (WHERE e ? 'default'), '{}'::jsonb)
    INTO v_names, v_defs FROM jsonb_array_elements(s.fields) e;
  IF p_update_fields IS NOT NULL AND EXISTS (
       SELECT 1 FROM unnest(p_update_fields) u WHERE NOT (u = ANY (COALESCE(v_names, '{}'))) AND u <> '_extra') THEN
    RAISE EXCEPTION 'data_items_upsert: update fields must be fields of "%"', p_schema_key;
  END IF;
  v_prefix := CASE WHEN s.legacy IS NOT NULL THEN 'library://' || (s.legacy->>'table') || '/' END;

  FOR r, n IN SELECT x.e, x.o - 1 FROM jsonb_array_elements(p_rows) WITH ORDINALITY x(e, o) LOOP
    SELECT * INTO p FROM data_prepare_row(s, r, n::int);
    v_errs := p.errors;
    v_item := NULL;
    v_ref := NULL;

    IF jsonb_array_length(v_errs) = 0 THEN
      v_ref := NULLIF(r->>'_legacy_ref', '');
      IF v_ref IS NOT NULL THEN
        IF v_prefix IS NULL OR left(v_ref, length(v_prefix)) <> v_prefix OR length(v_ref) = length(v_prefix) THEN
          v_errs := v_errs || jsonb_build_object('row', n, 'field', '_legacy_ref', 'error', 'legacy ref does not belong to this dataset');
        ELSIF s.legacy->>'id' = 'uuid'
              AND substr(v_ref, length(v_prefix) + 1) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          v_errs := v_errs || jsonb_build_object('row', n, 'field', '_legacy_ref', 'error', 'legacy ref must end with a uuid');
        ELSE
          SELECT * INTO v_item FROM data_items WHERE legacy_ref = v_ref AND schema_id = s.id FOR UPDATE;
        END IF;
      END IF;
    END IF;

    IF jsonb_array_length(v_errs) = 0 AND v_item.id IS NULL THEN
      v_key := p.key;
      IF v_key IS NULL AND cardinality(s.dedup_key) > 0 THEN
        v_errs := v_errs || jsonb_build_object('row', n, 'field', s.dedup_key[1], 'error', 'dedup key fields are empty');
      ELSIF v_key IS NOT NULL THEN
        SELECT * INTO v_item FROM data_items WHERE schema_id = s.id AND external_key = v_key FOR UPDATE;
      END IF;
    END IF;

    IF jsonb_array_length(v_errs) = 0 AND v_item.id IS NULL THEN
      -- ── insert ──
      v_new := v_defs || data_strip_top_nulls(p.data);
      FOR f IN SELECT e FROM jsonb_array_elements(s.fields) e
                WHERE (e->>'required')::boolean IS TRUE AND (e->>'deprecated')::boolean IS NOT TRUE LOOP
        IF NOT v_new ? (f->>'name') THEN
          v_errs := v_errs || jsonb_build_object('row', n, 'field', f->>'name', 'error', 'required');
        END IF;
      END LOOP;
      -- 083: a new row must have what the dataset needs for posting.
      IF jsonb_array_length(v_errs) = 0 THEN
        v_miss := data_post_missing(s.post_requires, v_new);
        IF cardinality(v_miss) > 0 THEN
          v_errs := v_errs || jsonb_build_object('row', n, 'field', split_part(v_miss[1], ' or ', 1),
                                                 'error', 'required for posting: ' || array_to_string(v_miss, '; '));
        END IF;
      END IF;
      IF jsonb_array_length(v_errs) = 0 AND v_prefix IS NOT NULL AND v_ref IS NULL THEN
        IF s.legacy->>'id' = 'uuid' THEN
          v_ref := v_prefix || gen_random_uuid()::text;
        ELSIF COALESCE(v_new->>(s.legacy->>'id_field'), '') = '' THEN
          v_errs := v_errs || jsonb_build_object('row', n, 'field', s.legacy->>'id_field', 'error', 'required');
        ELSE
          v_ref := v_prefix || (v_new->>(s.legacy->>'id_field'));
        END IF;
      END IF;
      IF jsonb_array_length(v_errs) = 0 THEN
        INSERT INTO data_items (schema_id, schema_version, external_key, data, legacy_ref, posted, import_id)
        VALUES (s.id, s.version, COALESCE(v_key, gen_random_uuid()::text), v_new, v_ref,
                CASE WHEN jsonb_typeof(r->'_posted') = 'object' THEN r->'_posted' ELSE '{}'::jsonb END,
                p_import_id)
        ON CONFLICT DO NOTHING
        RETURNING id INTO v_id;
        IF v_id IS NULL THEN skp := skp + 1; ELSE ins := ins + 1; END IF;
        v_id := NULL;
        CONTINUE;
      END IF;
    END IF;

    IF jsonb_array_length(v_errs) > 0 THEN
      nbad := nbad + 1;
      IF jsonb_array_length(bad) < 1000 THEN bad := bad || v_errs; END IF;
      CONTINUE;
    END IF;

    -- ── merge into the existing row ──
    IF p_update_fields IS NULL THEN
      v_patch := p.data;
    ELSE
      SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb) INTO v_patch
        FROM jsonb_each(p.data) e WHERE e.key = ANY (p_update_fields);
    END IF;
    IF v_patch = '{}'::jsonb THEN skp := skp + 1; CONTINUE; END IF;
    v_new := data_strip_top_nulls(v_item.data || v_patch);
    FOR f IN SELECT e FROM jsonb_array_elements(s.fields) e
              WHERE (e->>'required')::boolean IS TRUE AND (e->>'deprecated')::boolean IS NOT TRUE
                AND v_patch ? (e->>'name') LOOP
      IF NOT v_new ? (f->>'name') THEN
        v_errs := v_errs || jsonb_build_object('row', n, 'field', f->>'name', 'error', 'required');
      END IF;
    END LOOP;
    IF jsonb_array_length(v_errs) > 0 THEN
      nbad := nbad + 1;
      IF jsonb_array_length(bad) < 1000 THEN bad := bad || v_errs; END IF;
      CONTINUE;
    END IF;
    IF v_new = v_item.data THEN skp := skp + 1; CONTINUE; END IF;
    IF p_import_id IS NOT NULL THEN
      INSERT INTO data_import_snapshots (import_id, item_id, data, schema_version)
      VALUES (p_import_id, v_item.id, v_item.data, v_item.schema_version)
      ON CONFLICT DO NOTHING;
    END IF;
    UPDATE data_items SET data = v_new, schema_version = s.version WHERE id = v_item.id;
    upd := upd + 1;
  END LOOP;

  RETURN jsonb_build_object('inserted', ins, 'updated', upd, 'skipped', skp, 'invalid', bad, 'invalid_rows', nbad);
END $$;

-- ─── Stats: unposted network-wide counts only rows that can be posted ────────
-- (Same as 060, plus rows_unpostable and the data_postable() filter on unposted_network.)
CREATE OR REPLACE FUNCTION data_schema_stats_refresh(p_schema_id uuid DEFAULT NULL) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  s       record;
  v_n     int := 0;
  v_month smallint := EXTRACT(MONTH FROM (now() AT TIME ZONE 'Europe/Kyiv'))::smallint;
  v_day   smallint := EXTRACT(DAY   FROM (now() AT TIME ZONE 'Europe/Kyiv'))::smallint;
BEGIN
  FOR s IN SELECT id, key, reuse_policy, post_requires FROM data_schemas WHERE p_schema_id IS NULL OR id = p_schema_id LOOP
    INSERT INTO data_schema_stats AS t (schema_id, rows_total, rows_active, rows_hidden, rows_unpostable, unposted_network,
                                        today_items, top_categories, fill_rate, last_import_at, computed_at)
    SELECT s.id,
           count(*),
           count(*) FILTER (WHERE d.status = 'active'),
           count(*) FILTER (WHERE d.status = 'hidden'),
           count(*) FILTER (WHERE d.status = 'active' AND NOT data_postable(s.post_requires, d.data)),
           count(*) FILTER (WHERE d.status = 'active' AND data_postable(s.post_requires, d.data) AND NOT EXISTS (
               SELECT 1 FROM content_ledger l
                WHERE l.source_ref IN ('data://' || s.key || '/' || d.id, d.legacy_ref)
                  AND content_ledger_blocks(l.status, l.resource_ref, l.used_at, s.reuse_policy, NULL, 'network', now()))),
           count(*) FILTER (WHERE d.status = 'active' AND d.event_month = v_month AND d.event_day = v_day),
           COALESCE((SELECT jsonb_agg(jsonb_build_object('category', c.category, 'rows', c.n) ORDER BY c.n DESC)
                       FROM (SELECT category, count(*) AS n FROM data_items
                              WHERE schema_id = s.id AND status = 'active' AND category IS NOT NULL
                              GROUP BY category ORDER BY count(*) DESC LIMIT 10) c), '[]'::jsonb),
           COALESCE((SELECT jsonb_object_agg(fr.k, round(fr.n::numeric / NULLIF(fr.total, 0), 4))
                       FROM (SELECT k, count(*) AS n,
                                    (SELECT count(*) FROM data_items WHERE schema_id = s.id AND status = 'active') AS total
                               FROM data_items, jsonb_object_keys(data) k
                              WHERE schema_id = s.id AND status = 'active'
                              GROUP BY k) fr), '{}'::jsonb),
           (SELECT max(created_at) FROM data_imports WHERE schema_id = s.id AND status = 'committed'),
           now()
      FROM data_items d
     WHERE d.schema_id = s.id
    ON CONFLICT (schema_id) DO UPDATE SET
      rows_total = EXCLUDED.rows_total, rows_active = EXCLUDED.rows_active, rows_hidden = EXCLUDED.rows_hidden,
      rows_unpostable = EXCLUDED.rows_unpostable, unposted_network = EXCLUDED.unposted_network,
      today_items = EXCLUDED.today_items, top_categories = EXCLUDED.top_categories, fill_rate = EXCLUDED.fill_rate,
      last_import_at = EXCLUDED.last_import_at, computed_at = EXCLUDED.computed_at;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

-- ─── prompts: the rule, honest descriptions, the PromptHero repair ───────────

DO $$
DECLARE
  v_sid     uuid;
  v_ver     int;
  v_rows    jsonb;
  v_n       int;
  v_imp     uuid;
  r         jsonb;
  c_single  constant text := '^https?://(www\.)?prompthero\.com/prompt/[^/?#]+';
  c_image   constant text := '^https?://(cdn\.prompthero\.com/|(www\.)?prompthero\.com/_next/image)';
  c_fields  constant text[] := ARRAY['page_url', 'media_url', 'media_type'];
BEGIN
  SELECT id, version INTO v_sid, v_ver FROM data_schemas WHERE key = 'prompts';
  IF v_sid IS NULL THEN RETURN; END IF;

  -- The rule, unless the owner has set one already.
  UPDATE data_schemas SET post_requires = '[["page_url"], ["prompt_text", "media_url"]]'::jsonb
   WHERE id = v_sid AND post_requires = '[]'::jsonb;

  -- Descriptions as written by 058 promised a post-time scraper that no longer exists. Edited only when
  -- still the 058 text (an owner's own wording stays). Description edits keep the schema version.
  UPDATE data_schemas
     SET description = 'Prompts for image and video generators. PromptHero rows (provider prompthero) store the link to the prompt''s own page (page_url) and its example image (media_url); their prompt text is not stored. Curated GitHub rows (other providers) store the full prompt text and an example output.'
   WHERE id = v_sid
     AND description = 'Prompts for image and video generators. PromptHero rows (provider prompthero) store only the page link and image; the prompt text is scraped at post time. Curated GitHub rows (other providers) store the full prompt text and an example output.';
  UPDATE data_schemas
     SET fields = (SELECT jsonb_agg(CASE
                      WHEN e->>'name' = 'page_url' AND e->>'description' = 'Page of the prompt on its site.'
                        THEN e || jsonb_build_object('description', 'Page of this one prompt on its site (PromptHero: prompthero.com/prompt/…, never a gallery page).')
                      WHEN e->>'name' = 'prompt_text' AND e->>'description' = 'Full prompt text (curated rows only).'
                        THEN e || jsonb_build_object('description', 'Full prompt text (curated rows; empty for PromptHero rows).')
                      ELSE e END ORDER BY o)
                   FROM jsonb_array_elements(fields) WITH ORDINALITY x(e, o))
   WHERE id = v_sid
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(fields) e
                  WHERE (e->>'name' = 'page_url' AND e->>'description' = 'Page of the prompt on its site.')
                     OR (e->>'name' = 'prompt_text' AND e->>'description' = 'Full prompt text (curated rows only).'));

  -- PromptHero rows: page_url must be the prompt's own page, media_url the example image. Both are already
  -- in the row (prompt_source, id); a gallery page_url with no single-prompt link to replace it is cleared.
  SELECT jsonb_agg(jsonb_build_object('_external_key', d.external_key)
           || CASE WHEN COALESCE(d.data->>'page_url', '') !~* c_single THEN
                jsonb_build_object('page_url', CASE WHEN d.data->>'prompt_source' ~* c_single THEN d.data->>'prompt_source' END)
              ELSE '{}'::jsonb END
           || CASE WHEN NOT data_value_present(d.data->'media_url') AND d.data->>'id' ~* c_image THEN
                jsonb_build_object('media_url', d.data->>'id')
                || CASE WHEN NOT data_value_present(d.data->'media_type') THEN '{"media_type": "image"}'::jsonb ELSE '{}'::jsonb END
              ELSE '{}'::jsonb END
           ORDER BY d.id),
         count(*)
    INTO v_rows, v_n
    FROM data_items d
   WHERE d.schema_id = v_sid
     AND d.data->>'provider' = 'prompthero'
     AND (    (data_value_present(d.data->'page_url') AND d.data->>'page_url' !~* c_single)
           OR (NOT data_value_present(d.data->'page_url') AND d.data->>'prompt_source' ~* c_single)
           OR (NOT data_value_present(d.data->'media_url') AND d.data->>'id' ~* c_image));
  IF v_n = 0 THEN RETURN; END IF;

  INSERT INTO data_imports (schema_id, schema_version, source, filename, rows_total, status, created_by, options)
  VALUES (v_sid, v_ver, 'pipeline', '083_post_requires.sql (PromptHero page_url / media_url repair)', v_n, 'running',
          'migration:083', jsonb_build_object('updateFields', to_jsonb(c_fields)))
  RETURNING id INTO v_imp;
  r := data_items_upsert('prompts', v_rows, v_imp, c_fields);
  UPDATE data_imports
     SET status = 'committed', finished_at = now(), inserted = (r->>'inserted')::int, updated = (r->>'updated')::int,
         skipped = (r->>'skipped')::int, invalid = (r->>'invalid_rows')::int, errors = r->'invalid'
   WHERE id = v_imp;
  RAISE NOTICE '083: PromptHero repair % rows: %', v_n, r - 'invalid';
END $$;

SELECT data_schema_stats_refresh();
