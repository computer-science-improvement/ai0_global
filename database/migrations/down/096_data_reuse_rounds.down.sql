-- Down for 096_data_reuse_rounds.sql (spec 071). Order matters:
--   1. the triggers go first, so nothing rolls while the rest is undone;
--   2. cycle datasets become `never` and the `passed` ledger rows go (the old CHECKs allow neither);
--   3. the old CHECKs come back; the new policy validator goes after the CHECK that uses it;
--   4. the 060 / 083 function bodies come back before the helpers they were calling are dropped;
--   5. the rounds table goes last.
-- The 060 stats body is restored when data_schemas.post_requires is missing, the 083 body when it is there (the same guard
-- as the migration). Rounds carry no data that the ledger does not: a dataset that is turned into a cycle dataset again
-- starts at round 1.

DROP TRIGGER IF EXISTS trg_content_ledger_round ON content_ledger;
DROP TRIGGER IF EXISTS trg_data_schemas_reuse_round ON data_schemas;

UPDATE data_schemas SET reuse_policy = '{"kind":"never"}'::jsonb WHERE reuse_policy->>'kind' = 'cycle';
DELETE FROM content_ledger WHERE status = 'passed';

ALTER TABLE data_schemas DROP CONSTRAINT IF EXISTS data_schemas_reuse_policy_check;
ALTER TABLE data_schemas ADD CONSTRAINT data_schemas_reuse_policy_check CHECK (reuse_policy->>'kind' IN ('never','after_days'));
DROP FUNCTION IF EXISTS data_reuse_policy_valid(jsonb);

ALTER TABLE content_ledger DROP CONSTRAINT IF EXISTS content_ledger_status_check;
ALTER TABLE content_ledger ADD CONSTRAINT content_ledger_status_check CHECK (status IN ('published','shadowed','error'));

-- 060 bodies.
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

CREATE OR REPLACE FUNCTION content_ledger_used(p_resource text, p_now timestamptz DEFAULT now())
RETURNS TABLE (ref text)
LANGUAGE sql STABLE AS $$
  SELECT l.source_ref
    FROM content_ledger l
    LEFT JOIN data_schemas s ON l.source_ref LIKE 'data://%' AND s.key = split_part(substr(l.source_ref, 8), '/', 1)
   WHERE (l.status = 'error' OR l.resource_ref = p_resource)
     AND content_ledger_blocks(l.status, l.resource_ref, l.used_at, COALESCE(s.reuse_policy, '{"kind":"never"}'::jsonb), p_resource, 'resource', p_now)
$$;

-- Stats: the 083 body when the dataset rule is in place, else the 060 body.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'data_schemas' AND column_name = 'post_requires') THEN
    EXECUTE $fn$
CREATE OR REPLACE FUNCTION data_schema_stats_refresh(p_schema_id uuid DEFAULT NULL) RETURNS int
LANGUAGE plpgsql AS $body$
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
END $body$
    $fn$;
  ELSE
    EXECUTE $fn$
CREATE OR REPLACE FUNCTION data_schema_stats_refresh(p_schema_id uuid DEFAULT NULL) RETURNS int
LANGUAGE plpgsql AS $body$
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
END $body$
    $fn$;
  END IF;
END $do$;

DROP FUNCTION IF EXISTS content_ledger_pass(text, text, text, uuid, text);
DROP FUNCTION IF EXISTS data_round_roll(uuid, text);
DROP FUNCTION IF EXISTS content_ledger_round_after();
DROP FUNCTION IF EXISTS data_schemas_reuse_round_after();
DROP FUNCTION IF EXISTS content_ref_reuse_at(text, text);
DROP FUNCTION IF EXISTS content_reuse_at(jsonb, timestamptz);
DROP TABLE IF EXISTS data_reuse_rounds;
DELETE FROM schema_migrations WHERE version = '096_data_reuse_rounds';
