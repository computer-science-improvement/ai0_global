-- 060_content_ledger.sql — one dedup ledger for every publish path (spec 023 FR-010, T1).
--
-- Until now "was this already posted here?" lived in four places with four windows: the `posted` JSONB of
-- the content rows (now data_items.posted), posted_news (global by URL), published_posts.source_url and
-- platform_posts.source_ref. content_ledger replaces them as the one place the publish guards, the chat,
-- query_data / search_library and library_catalog read.
--
-- • content_ledger(resource_ref, source_ref, status) — one row per (resource, canonical ref, status);
--   a repeat publication moves used_at forward.
-- • Canonical refs: data://<schema_key>/<id> for data store rows (a library://<table>/<old id> alias
--   resolves through data_items.legacy_ref, spec 032 FR-011); a normalised URL (lower-case scheme and
--   host, no utm_* parameters, no fragment); anything else (digest://…, pdr:…) as given, trimmed.
-- • Rules (content_ledger_blocks): `error` excludes the item everywhere; `published` blocks the same
--   resource, for ever or — for a dataset whose data_schemas.reuse_policy is after_days — for that many
--   days; `shadowed` blocks the same resource for 7 days.
-- • Writers: the automation calls content_ledger_record() (ContentLedger.record) on every publish path.
--   The two legacy ledgers that strategies still write — data_items.posted (through the compatibility
--   views) and posted_news — feed the ledger through triggers until they are archived.
-- • Backfill: content_ledger_backfill() reads all four legacy ledgers plus shadowed/published editor
--   slots; it is idempotent (a rerun inserts nothing) and runs once here.
--
-- Additive and idempotent. data_items.posted and posted_news stay (read-only for dedup, archived later).

CREATE TABLE IF NOT EXISTS content_ledger (
  id                BIGSERIAL PRIMARY KEY,
  resource_ref      TEXT NOT NULL,
  source_ref        TEXT NOT NULL,
  origin            TEXT NOT NULL CHECK (origin IN ('strategy','editor','chat','platform','manual','backfill')),
  status            TEXT NOT NULL CHECK (status IN ('published','shadowed','error')),
  published_post_id BIGINT,
  platform_post_id  BIGINT,
  slot_id           UUID,
  used_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The reason of an `error` row (from the legacy marker); free text.
  note              TEXT,
  UNIQUE (resource_ref, source_ref, status)
);
CREATE INDEX IF NOT EXISTS idx_content_ledger_source   ON content_ledger (source_ref);
CREATE INDEX IF NOT EXISTS idx_content_ledger_resource ON content_ledger (resource_ref, used_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_ledger_errors   ON content_ledger (source_ref) WHERE status = 'error';

-- ─── Canonical refs ──────────────────────────────────────────────────────────

-- http(s) URL → lower-case scheme and host, utm_* parameters and the fragment dropped. Other text unchanged.
CREATE OR REPLACE FUNCTION content_url_canonical(p text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  m  text[];
  q  text;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  m := regexp_match(btrim(p), '^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$');
  IF m IS NULL OR lower(m[1]) NOT IN ('http', 'https') THEN RETURN btrim(p); END IF;
  IF m[4] IS NOT NULL AND length(m[4]) > 1 THEN
    SELECT string_agg(part, '&' ORDER BY n) INTO q
      FROM unnest(string_to_array(substr(m[4], 2), '&')) WITH ORDINALITY AS t(part, n)
     WHERE part <> '' AND lower(split_part(part, '=', 1)) NOT LIKE 'utm\_%';
  END IF;
  RETURN lower(m[1]) || '://' || lower(m[2]) || COALESCE(m[3], '') || CASE WHEN q IS NULL OR q = '' THEN '' ELSE '?' || q END;
END $$;

-- Any source ref → its canonical form (NULL for blank). A library:// ref of a moved row → data://.
CREATE OR REPLACE FUNCTION content_ref_canonical(p text) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  t   text := btrim(COALESCE(p, ''));
  v   text;
BEGIN
  IF t = '' THEN RETURN NULL; END IF;
  IF t ~ '^library://' THEN
    SELECT 'data://' || s.key || '/' || d.id INTO v
      FROM data_items d JOIN data_schemas s ON s.id = d.schema_id WHERE d.legacy_ref = t;
    RETURN COALESCE(v, t);
  END IF;
  IF t ~* '^https?://' THEN RETURN content_url_canonical(t); END IF;
  RETURN t;
END $$;

-- Every spelling the ledger may hold for one ref: the canonical form, the ref as given and, for a
-- data store row, its legacy library:// alias.
CREATE OR REPLACE FUNCTION content_ref_aliases(p text) RETURNS text[]
LANGUAGE plpgsql STABLE AS $$
DECLARE
  c   text := content_ref_canonical(p);
  m   text[];
  lr  text;
BEGIN
  IF c IS NULL THEN RETURN ARRAY[]::text[]; END IF;
  m := regexp_match(c, '^data://([a-z][a-z0-9_]{1,62})/([0-9]{1,18})$');
  IF m IS NOT NULL THEN
    SELECT d.legacy_ref INTO lr FROM data_items d JOIN data_schemas s ON s.id = d.schema_id
     WHERE s.key = m[1] AND d.id = m[2]::bigint;
  END IF;
  RETURN ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[c, btrim(p), lr]) x WHERE x IS NOT NULL AND x <> '');
END $$;

-- The reuse policy behind a canonical ref: the dataset's data_schemas.reuse_policy for data://, else never.
CREATE OR REPLACE FUNCTION content_ref_reuse(p_source text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT s.reuse_policy FROM data_schemas s
      WHERE p_source LIKE 'data://%' AND s.key = split_part(substr(p_source, 8), '/', 1)),
    '{"kind":"never"}'::jsonb)
$$;

-- ─── Rules ───────────────────────────────────────────────────────────────────

-- Does one ledger row stop `p_source` on `p_resource`? p_scope = 'network' counts a publication on any
-- resource (used for "unposted network-wide"). A published row on the wildcard 'telegram:*' (a legacy
-- TELEGRAM marker whose channel is unknown) only counts network-wide.
CREATE OR REPLACE FUNCTION content_ledger_blocks(
  p_status text, p_row_resource text, p_used_at timestamptz, p_reuse jsonb,
  p_resource text, p_scope text, p_now timestamptz
) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_status
    WHEN 'error' THEN true
    WHEN 'published' THEN
      (p_scope = 'network' OR p_row_resource = p_resource)
      AND (COALESCE(p_reuse->>'kind', 'never') <> 'after_days'
           OR p_used_at > p_now - make_interval(days => GREATEST(COALESCE((p_reuse->>'days')::int, 0), 0)))
    WHEN 'shadowed' THEN p_row_resource = p_resource AND p_used_at > p_now - interval '7 days'
    ELSE false
  END
$$;

-- The ledger rows that stop any of `p_refs` on `p_resource`, the strongest first (error, published, shadowed).
CREATE OR REPLACE FUNCTION content_ledger_blocking(
  p_resource text, p_refs text[], p_scope text DEFAULT 'resource', p_now timestamptz DEFAULT now()
) RETURNS TABLE (status text, resource_ref text, source_ref text, used_at timestamptz, slot_id uuid)
LANGUAGE sql STABLE AS $$
  SELECT l.status, l.resource_ref, l.source_ref, l.used_at, l.slot_id
    FROM content_ledger l
   WHERE l.source_ref = ANY (p_refs)
     AND content_ledger_blocks(l.status, l.resource_ref, l.used_at, content_ref_reuse(l.source_ref), p_resource, p_scope, p_now)
   ORDER BY CASE l.status WHEN 'error' THEN 0 WHEN 'published' THEN 1 ELSE 2 END, l.used_at DESC
$$;

-- Every ref the ledger stops on one resource (query_data's unposted_on, library_catalog's unposted_here).
CREATE OR REPLACE FUNCTION content_ledger_used(p_resource text, p_now timestamptz DEFAULT now())
RETURNS TABLE (ref text)
LANGUAGE sql STABLE AS $$
  SELECT l.source_ref
    FROM content_ledger l
    LEFT JOIN data_schemas s ON l.source_ref LIKE 'data://%' AND s.key = split_part(substr(l.source_ref, 8), '/', 1)
   WHERE (l.status = 'error' OR l.resource_ref = p_resource)
     AND content_ledger_blocks(l.status, l.resource_ref, l.used_at, COALESCE(s.reuse_policy, '{"kind":"never"}'::jsonb), p_resource, 'resource', p_now)
$$;

-- The dated datasets may repeat after 300 days (023 FR-010). The 058 seed said 365, which would block the
-- same calendar date next year whenever it is posted earlier in the day than last time. Only a policy
-- still at the seed value changes (an owner's own choice stays). Description-only: no version bump.
UPDATE data_schemas SET reuse_policy = '{"kind":"after_days","days":300}'::jsonb
 WHERE key IN ('on_this_day', 'birthdays', 'name_days')
   AND reuse_policy = '{"kind":"after_days","days":365}'::jsonb;

-- ─── Writes ──────────────────────────────────────────────────────────────────

-- Record one use. Returns true when a new row was written; a repeat moves used_at (and the post ids)
-- forward, never back. Blank refs are ignored.
CREATE OR REPLACE FUNCTION content_ledger_record(
  p_resource text, p_source text, p_origin text, p_status text,
  p_published_post_id bigint DEFAULT NULL, p_platform_post_id bigint DEFAULT NULL, p_slot_id uuid DEFAULT NULL,
  p_used_at timestamptz DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_src  text := content_ref_canonical(p_source);
  v_res  text := NULLIF(btrim(COALESCE(p_resource, '')), '');
  v_new  boolean;
BEGIN
  IF v_src IS NULL OR v_res IS NULL THEN RETURN false; END IF;
  INSERT INTO content_ledger AS l (resource_ref, source_ref, origin, status, published_post_id, platform_post_id, slot_id, used_at, note)
  VALUES (v_res, v_src, p_origin, p_status, p_published_post_id, p_platform_post_id, p_slot_id, COALESCE(p_used_at, now()), left(p_note, 500))
  ON CONFLICT (resource_ref, source_ref, status) DO UPDATE SET
    used_at           = EXCLUDED.used_at,
    published_post_id = COALESCE(EXCLUDED.published_post_id, l.published_post_id),
    platform_post_id  = COALESCE(EXCLUDED.platform_post_id, l.platform_post_id),
    slot_id           = COALESCE(EXCLUDED.slot_id, l.slot_id),
    note              = COALESCE(EXCLUDED.note, l.note)
    WHERE EXCLUDED.used_at > l.used_at
  RETURNING (xmax = 0) INTO v_new;
  RETURN COALESCE(v_new, false);
END $$;

-- ─── Legacy `posted` markers → resources ─────────────────────────────────────

-- The strategy types whose bindings published a dataset under the shared 'TELEGRAM' key.
CREATE OR REPLACE FUNCTION content_ledger_binding_types(p_schema_key text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_schema_key
    WHEN 'recipes'       THEN ARRAY['recipes', 'recipe-carousel']
    WHEN 'prompts'       THEN ARRAY['ai0-prompts', 'curated-prompts']
    WHEN 'birthdays'     THEN ARRAY['birthday-strategy']
    WHEN 'pdr_questions' THEN ARRAY['pdr-quiz']
    WHEN 'on_this_day'   THEN ARRAY['on-this-day']
    ELSE ARRAY[p_schema_key, replace(p_schema_key, '_', '-')]
  END
$$;

-- A `posted` key (without its 'error:' prefix) → the resource refs it stands for:
--   IG:/FB:/TH:/TT:<uuid> → instagram:/facebook:/threads:/tiktok:<uuid>;
--   TELEGRAM → every Telegram channel with a binding of the dataset's strategy types, or the wildcard
--              'telegram:*' when there is none (counted network-wide only);
--   anything else → a Telegram channel key (telegram:<key>).
CREATE OR REPLACE FUNCTION content_posted_resources(p_schema_key text, p_key text) RETURNS SETOF text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  k  text := btrim(COALESCE(p_key, ''));
  n  int := 0;
  r  text;
BEGIN
  IF k = '' THEN RETURN; END IF;
  IF k ~ '^(IG|FB|TH|TT):.+' THEN
    RETURN NEXT CASE split_part(k, ':', 1) WHEN 'IG' THEN 'instagram' WHEN 'FB' THEN 'facebook' WHEN 'TH' THEN 'threads' ELSE 'tiktok' END
                || ':' || substr(k, 4);
    RETURN;
  END IF;
  IF k = 'TELEGRAM' THEN
    FOR r IN
      SELECT DISTINCT 'telegram:' || tc.channel_key
        FROM strategy_bindings b JOIN tracked_channels tc ON tc.id = b.channel_id
       WHERE b.platform = 'telegram' AND b.type = ANY (content_ledger_binding_types(p_schema_key)) AND tc.channel_key IS NOT NULL
    LOOP
      n := n + 1;
      RETURN NEXT r;
    END LOOP;
    IF n = 0 THEN RETURN NEXT 'telegram:*'; END IF;
    RETURN;
  END IF;
  IF k ~ '^(telegram|instagram|facebook|threads|tiktok|youtube):.+' THEN RETURN NEXT k; RETURN; END IF;
  RETURN NEXT 'telegram:' || k;
END $$;

-- A JSON marker value → its time: a timestamp string, or {at: …} for error markers; NULL when unreadable.
CREATE OR REPLACE FUNCTION content_marker_time(v jsonb) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  s text := CASE jsonb_typeof(v) WHEN 'string' THEN v #>> '{}' WHEN 'object' THEN v->>'at' ELSE NULL END;
BEGIN
  IF s IS NULL OR s = '' THEN RETURN NULL; END IF;
  RETURN s::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;

-- Live: a strategy marks a row posted (through the compatibility views) → the ledger gets the same use.
CREATE OR REPLACE FUNCTION data_items_posted_ledger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  e       record;
  v_key   text;
  v_err   boolean;
  v_res   text;
  v_ref   text;
BEGIN
  SELECT 'data://' || s.key || '/' || NEW.id, s.key INTO v_ref, v_key FROM data_schemas s WHERE s.id = NEW.schema_id;
  FOR e IN SELECT j.key, j.value FROM jsonb_each(COALESCE(NEW.posted, '{}'::jsonb)) j
            WHERE TG_OP = 'INSERT' OR (OLD.posted -> j.key) IS DISTINCT FROM j.value
  LOOP
    v_err := e.key LIKE 'error:%';
    FOR v_res IN SELECT * FROM content_posted_resources(v_key, CASE WHEN v_err THEN substr(e.key, 7) ELSE e.key END) LOOP
      PERFORM content_ledger_record(v_res, v_ref, 'strategy', CASE WHEN v_err THEN 'error' ELSE 'published' END,
                                    NULL, NULL, NULL, COALESCE(content_marker_time(e.value), now()),
                                    CASE WHEN v_err THEN e.value->>'reason' END);
    END LOOP;
  END LOOP;
  RETURN NULL;
EXCEPTION WHEN others THEN
  -- Dedup bookkeeping must never fail the write that published the post.
  RAISE WARNING 'content_ledger: posted marker of data_items % not recorded: %', NEW.id, SQLERRM;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_data_items_posted_ledger ON data_items;
CREATE TRIGGER trg_data_items_posted_ledger
  AFTER INSERT OR UPDATE OF posted ON data_items
  FOR EACH ROW WHEN (NEW.posted IS NOT NULL AND NEW.posted <> '{}'::jsonb)
  EXECUTE FUNCTION data_items_posted_ledger();

-- Live: the news strategies' posted_news rows (global URL dedup) → the ledger.
CREATE OR REPLACE FUNCTION posted_news_ledger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM content_ledger_record(
    CASE WHEN NEW.channel_id ~ '^(telegram|instagram|facebook|threads|tiktok|youtube):.+' THEN NEW.channel_id ELSE 'telegram:' || NEW.channel_id END,
    NEW.source_url, 'strategy', CASE WHEN NEW.content_type = 'error' THEN 'error' ELSE 'published' END,
    NULL, NULL, NULL, NEW.created_at, CASE WHEN NEW.content_type = 'error' THEN NEW.title END);
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'content_ledger: posted_news % not recorded: %', NEW.id, SQLERRM;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_posted_news_ledger ON posted_news;
CREATE TRIGGER trg_posted_news_ledger AFTER INSERT ON posted_news
  FOR EACH ROW EXECUTE FUNCTION posted_news_ledger();

-- ─── Backfill (idempotent: a rerun inserts nothing) ──────────────────────────

CREATE OR REPLACE FUNCTION content_ledger_backfill() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_posted int; v_news int; v_pub int; v_plat int; v_slots int;
BEGIN
  -- 1. `posted` markers on the data store rows.
  INSERT INTO content_ledger (resource_ref, source_ref, origin, status, used_at, note)
  SELECT r.res, r.ref, 'backfill', r.status, COALESCE(max(r.at), now()), max(r.note)
    FROM (
      SELECT 'data://' || s.key || '/' || d.id AS ref,
             CASE WHEN e.key LIKE 'error:%' THEN 'error' ELSE 'published' END AS status,
             content_marker_time(e.value) AS at,
             CASE WHEN e.key LIKE 'error:%' THEN e.value->>'reason' END AS note,
             res
        FROM data_items d
        JOIN data_schemas s ON s.id = d.schema_id
        CROSS JOIN LATERAL jsonb_each(d.posted) e
        CROSS JOIN LATERAL content_posted_resources(s.key, CASE WHEN e.key LIKE 'error:%' THEN substr(e.key, 7) ELSE e.key END) res
       WHERE d.posted <> '{}'::jsonb
    ) r
   GROUP BY r.res, r.ref, r.status
  ON CONFLICT (resource_ref, source_ref, status) DO NOTHING;
  GET DIAGNOSTICS v_posted = ROW_COUNT;

  -- 2. posted_news (the news strategies' URL ledger).
  INSERT INTO content_ledger (resource_ref, source_ref, origin, status, used_at, note)
  SELECT res, ref, 'backfill', status, max(created_at), max(note)
    FROM (
      SELECT CASE WHEN n.channel_id ~ '^(telegram|instagram|facebook|threads|tiktok|youtube):.+' THEN n.channel_id ELSE 'telegram:' || n.channel_id END AS res,
             content_ref_canonical(n.source_url) AS ref,
             CASE WHEN n.content_type = 'error' THEN 'error' ELSE 'published' END AS status,
             n.created_at,
             CASE WHEN n.content_type = 'error' THEN left(n.title, 500) END AS note
        FROM posted_news n
    ) x
   WHERE ref IS NOT NULL
   GROUP BY res, ref, status
  ON CONFLICT (resource_ref, source_ref, status) DO NOTHING;
  GET DIAGNOSTICS v_news = ROW_COUNT;

  -- 3. published_posts (Telegram: strategies, the editor, the chat, sponsored posts).
  INSERT INTO content_ledger (resource_ref, source_ref, origin, status, published_post_id, slot_id, used_at)
  SELECT DISTINCT ON (res, ref) res, ref, 'backfill', 'published', id, editor_slot_id, posted_at
    FROM (
      SELECT 'telegram:' || p.channel_id AS res, content_ref_canonical(p.source_url) AS ref, p.id, p.editor_slot_id, p.posted_at
        FROM published_posts p WHERE p.source_url IS NOT NULL
    ) x
   WHERE ref IS NOT NULL
   ORDER BY res, ref, posted_at DESC
  ON CONFLICT (resource_ref, source_ref, status) DO NOTHING;
  GET DIAGNOSTICS v_pub = ROW_COUNT;

  -- 4. platform_posts (Instagram, Facebook, Threads, TikTok, YouTube): published and shadowed.
  INSERT INTO content_ledger (resource_ref, source_ref, origin, status, platform_post_id, slot_id, used_at)
  SELECT DISTINCT ON (resource_ref, ref, status) resource_ref, ref, 'backfill', status, id, slot_id, posted_at
    FROM (
      SELECT pp.resource_ref, content_ref_canonical(pp.source_ref) AS ref, pp.status, pp.id, pp.slot_id, pp.posted_at
        FROM platform_posts pp WHERE pp.status IN ('published', 'shadowed') AND pp.source_ref IS NOT NULL
    ) x
   WHERE ref IS NOT NULL
   ORDER BY resource_ref, ref, status, posted_at DESC
  ON CONFLICT (resource_ref, source_ref, status) DO NOTHING;
  GET DIAGNOSTICS v_plat = ROW_COUNT;

  -- 5. Editor slots: shadow previews (blocked 7 days) and published posts whose spec names both a
  --    library item and a source URL (published_posts keeps only one of them).
  INSERT INTO content_ledger (resource_ref, source_ref, origin, status, slot_id, used_at)
  SELECT DISTINCT ON (res, ref, status) res, ref, 'backfill', status, id, updated_at
    FROM (
      SELECT COALESCE(sl.resource_ref, 'telegram:' || sl.channel_key) AS res, content_ref_canonical(x.r) AS ref,
             sl.status, sl.id, sl.updated_at
        FROM editor_slots sl
        CROSS JOIN LATERAL unnest(ARRAY[
          sl.post_spec->>'library_ref', sl.post_spec->'source'->>'url',
          sl.platform_spec->>'library_ref', sl.platform_spec->'source'->>'url']) x(r)
       WHERE sl.status IN ('shadowed', 'published') AND x.r IS NOT NULL
    ) y
   WHERE ref IS NOT NULL
   ORDER BY res, ref, status, updated_at DESC
  ON CONFLICT (resource_ref, source_ref, status) DO NOTHING;
  GET DIAGNOSTICS v_slots = ROW_COUNT;

  RETURN jsonb_build_object('posted', v_posted, 'posted_news', v_news, 'published_posts', v_pub,
                            'platform_posts', v_plat, 'editor_slots', v_slots,
                            'total', v_posted + v_news + v_pub + v_plat + v_slots);
END $$;

DO $$
DECLARE r jsonb;
BEGIN
  r := content_ledger_backfill();
  RAISE NOTICE '060: content_ledger backfill %', r;
END $$;

-- ─── Stats: unposted network-wide now comes from the ledger ──────────────────
-- (spec 032 FR-010 — same columns as 058, only `unposted_network` changes source.)
CREATE OR REPLACE FUNCTION data_schema_stats_refresh(p_schema_id uuid DEFAULT NULL) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  s       record;
  v_n     int := 0;
  v_month smallint := EXTRACT(MONTH FROM (now() AT TIME ZONE 'Europe/Kyiv'))::smallint;
  v_day   smallint := EXTRACT(DAY   FROM (now() AT TIME ZONE 'Europe/Kyiv'))::smallint;
BEGIN
  FOR s IN SELECT id, key, reuse_policy FROM data_schemas WHERE p_schema_id IS NULL OR id = p_schema_id LOOP
    INSERT INTO data_schema_stats AS t (schema_id, rows_total, rows_active, rows_hidden, unposted_network,
                                        today_items, top_categories, fill_rate, last_import_at, computed_at)
    SELECT s.id,
           count(*),
           count(*) FILTER (WHERE d.status = 'active'),
           count(*) FILTER (WHERE d.status = 'hidden'),
           count(*) FILTER (WHERE d.status = 'active' AND NOT EXISTS (
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
      unposted_network = EXCLUDED.unposted_network, today_items = EXCLUDED.today_items,
      top_categories = EXCLUDED.top_categories, fill_rate = EXCLUDED.fill_rate,
      last_import_at = EXCLUDED.last_import_at, computed_at = EXCLUDED.computed_at;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

SELECT data_schema_stats_refresh();

-- ─── Read access for agent SQL (editor_ro, migration 042) ────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    GRANT SELECT ON content_ledger TO editor_ro;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'editor_ro grants skipped (insufficient privilege)';
END $$;

INSERT INTO schema_migrations (version) VALUES ('060_content_ledger')
  ON CONFLICT (version) DO NOTHING;
