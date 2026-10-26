-- 096_data_reuse_rounds.sql — a dataset may repeat in rounds, in order or at random (spec 071).
--
-- The owner (2026-10-26): content may repeat, either in order or at random, but only after everything was published;
-- in random mode only what was not published in this round is a candidate, and after the last one a new round starts.
-- Until now a dataset was `never` (each row once per channel, for ever) or `after_days N` (a row returns on its own
-- clock, whether or not the rest was posted): @pdr_dev_channel used all 866 rows of pdr_questions by June and has had
-- no material since.
--
--   reuse_policy {"kind":"cycle","order":"sequential"|"random","order_by":[…]}
--   data_reuse_rounds        one row per (dataset, resource): the round number and when it started. No row = round 1
--                            with no start, so every earlier publication counts in round 1.
--   content_ledger 'passed'  a row that cannot be posted is done for the round on that resource (cycle datasets only,
--                            never network-wide).
--   data_round_roll()        starts the next round when no active, postable row is open on the resource.
--   triggers                 a data:// ledger row (published / passed) rolls the round of a cycle dataset; switching a
--                            dataset to cycle starts clean rounds and rolls the resources that already used it all.
--
-- The ledger functions keep their signatures AND their OUT columns (094 explains why: a rerun of 060 re-creates the old
-- form, and a second overload would make every call ambiguous). The round start of the ledger row's own resource travels
-- inside the policy JSON as `since` (content_reuse_at / content_ref_reuse_at); content_ledger_blocks reads it, so it
-- becomes STABLE.
--
-- Additive and idempotent. database/ci-bootstrap-check.sh re-applies 042+ in lexical order (060 and 083 run again before
-- this file), so this file stays lexically last for these functions and re-creates the final bodies. It calls no
-- stats refresh, and everything that needs 083 (data_postable, post_requires, rows_unpostable) sits inside plpgsql or an
-- EXECUTE guarded by the column: post-requires.migration.pg.test.ts applies every migration but 083 first and then calls
-- data_schema_stats_refresh() itself.

-- ─── The policy shape ────────────────────────────────────────────────────────

-- CASE, not AND, wherever a cast or an array function follows a type test: SQL does not promise to stop at the first false.
CREATE OR REPLACE FUNCTION data_reuse_policy_valid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(p) IS DISTINCT FROM 'object' THEN false
    WHEN p->>'kind' = 'never' THEN true
    WHEN p->>'kind' = 'after_days' THEN CASE
      WHEN p->'days' IS NULL THEN true
      WHEN jsonb_typeof(p->'days') <> 'number' THEN false
      WHEN (p->>'days') ~ '^[0-9]{1,4}$' THEN (p->>'days')::int BETWEEN 1 AND 3650
      ELSE false END
    WHEN p->>'kind' = 'cycle' THEN
      (p->'order' IS NULL OR p->>'order' IN ('sequential', 'random'))
      AND CASE
        WHEN p->'order_by' IS NULL THEN true
        WHEN jsonb_typeof(p->'order_by') <> 'array' THEN false
        ELSE jsonb_array_length(p->'order_by') BETWEEN 1 AND 3
             AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p->'order_by') e
                              WHERE jsonb_typeof(e) <> 'string' OR (e #>> '{}') !~ '^[a-z][a-z0-9_]{0,62}$')
      END
    ELSE false
  END
$$;

-- The 058 CHECK is inline, so PG named it; find it by what it says. Every CHECK on reuse_policy goes, then ours is added.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'data_schemas'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%reuse_policy%' LOOP
    EXECUTE format('ALTER TABLE data_schemas DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE data_schemas ADD CONSTRAINT data_schemas_reuse_policy_check CHECK (data_reuse_policy_valid(reuse_policy));
END $$;

-- ─── The ledger status `passed` ──────────────────────────────────────────────

-- The 060 status CHECK (the only one that names `shadowed`; the 094 anchor CHECK stays).
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'content_ledger'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%shadowed%' LOOP
    EXECUTE format('ALTER TABLE content_ledger DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE content_ledger ADD CONSTRAINT content_ledger_status_check
    CHECK (status IN ('published', 'shadowed', 'error', 'passed'));
END $$;

-- ─── Rounds ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS data_reuse_rounds (
  schema_id    UUID NOT NULL REFERENCES data_schemas(id) ON DELETE CASCADE,
  resource_ref TEXT NOT NULL,
  round        INT  NOT NULL DEFAULT 1 CHECK (round >= 1),
  started_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (schema_id, resource_ref)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    GRANT SELECT ON data_reuse_rounds TO editor_ro;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'editor_ro grants skipped (insufficient privilege)';
END $$;

-- ─── Helpers (new names: no new overloads of the 060 functions) ──────────────

-- The policy with the round start of one resource inside (cycle only). STABLE: the timestamp goes through to_jsonb.
CREATE OR REPLACE FUNCTION content_reuse_at(p_policy jsonb, p_since timestamptz) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_policy->>'kind' = 'cycle' AND p_since IS NOT NULL
              THEN p_policy || jsonb_build_object('since', p_since)
              ELSE COALESCE(p_policy, '{"kind":"never"}'::jsonb) END
$$;

-- content_ref_reuse for the ledger row of `p_row_resource`: a cycle dataset carries that resource's round start.
CREATE OR REPLACE FUNCTION content_ref_reuse_at(p_source text, p_row_resource text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT content_reuse_at(s.reuse_policy, r.started_at)
       FROM data_schemas s
       LEFT JOIN data_reuse_rounds r ON r.schema_id = s.id AND r.resource_ref = p_row_resource
      WHERE p_source LIKE 'data://%' AND s.key = split_part(substr(p_source, 8), '/', 1)),
    '{"kind":"never"}'::jsonb)
$$;

-- ─── Rules ───────────────────────────────────────────────────────────────────

-- 060's rules plus `cycle` and `passed`. p_reuse may carry `since` (the round start of the ledger row's resource):
--   • published, cycle — blocks while used_at is after `since` (no `since`: round 1, every publication counts);
--   • passed           — only in resource scope, on the same resource, in a cycle dataset, in the current round.
-- STABLE now: the cast of `since` is STABLE. Same signature as 060.
CREATE OR REPLACE FUNCTION content_ledger_blocks(
  p_status text, p_row_resource text, p_used_at timestamptz, p_reuse jsonb,
  p_resource text, p_scope text, p_now timestamptz
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE p_status
    WHEN 'error' THEN true
    WHEN 'published' THEN
      (p_scope = 'network' OR p_row_resource = p_resource)
      AND CASE COALESCE(p_reuse->>'kind', 'never')
            WHEN 'after_days' THEN p_used_at > p_now - make_interval(days => GREATEST(COALESCE((p_reuse->>'days')::int, 0), 0))
            WHEN 'cycle'      THEN p_reuse->>'since' IS NULL OR p_used_at > (p_reuse->>'since')::timestamptz
            ELSE true
          END
    WHEN 'passed' THEN
      COALESCE(p_scope = 'resource' AND p_row_resource = p_resource AND p_reuse->>'kind' = 'cycle'
               AND (p_reuse->>'since' IS NULL OR p_used_at > (p_reuse->>'since')::timestamptz), false)
    WHEN 'shadowed' THEN p_row_resource = p_resource AND p_used_at > p_now - interval '7 days'
    ELSE false
  END
$$;

-- The ledger rows that stop any of `p_refs` on `p_resource`, the strongest first (error, published, passed, shadowed).
-- Same signature and columns as 060; the policy now carries the round start of l.resource_ref.
CREATE OR REPLACE FUNCTION content_ledger_blocking(
  p_resource text, p_refs text[], p_scope text DEFAULT 'resource', p_now timestamptz DEFAULT now()
) RETURNS TABLE (status text, resource_ref text, source_ref text, used_at timestamptz, slot_id uuid)
LANGUAGE sql STABLE AS $$
  SELECT l.status, l.resource_ref, l.source_ref, l.used_at, l.slot_id
    FROM content_ledger l
   WHERE l.source_ref = ANY (p_refs)
     AND content_ledger_blocks(l.status, l.resource_ref, l.used_at, content_ref_reuse_at(l.source_ref, l.resource_ref), p_resource, p_scope, p_now)
   ORDER BY CASE l.status WHEN 'error' THEN 0 WHEN 'published' THEN 1 WHEN 'passed' THEN 2 ELSE 3 END, l.used_at DESC
$$;

-- Every ref the ledger stops on one resource (query_data's unposted_on, library_catalog's unposted_here).
CREATE OR REPLACE FUNCTION content_ledger_used(p_resource text, p_now timestamptz DEFAULT now())
RETURNS TABLE (ref text)
LANGUAGE sql STABLE AS $$
  SELECT l.source_ref
    FROM content_ledger l
    LEFT JOIN data_schemas s ON l.source_ref LIKE 'data://%' AND s.key = split_part(substr(l.source_ref, 8), '/', 1)
    LEFT JOIN data_reuse_rounds r ON r.schema_id = s.id AND r.resource_ref = l.resource_ref
   WHERE (l.status = 'error' OR l.resource_ref = p_resource)
     AND content_ledger_blocks(l.status, l.resource_ref, l.used_at,
                               content_reuse_at(COALESCE(s.reuse_policy, '{"kind":"never"}'::jsonb), r.started_at),
                               p_resource, 'resource', p_now)
$$;

-- ─── Stats: unposted network-wide counts a row as posted in its resource's current round ─────────
-- The 083 body (rows_unpostable, data_postable) plus the round start of l.resource_ref. Only when 083 is in place: a
-- database without data_schemas.post_requires keeps the 060 body (post-requires.migration.pg.test.ts calls the function
-- before 083 exists). The CREATE goes through EXECUTE so this file parses without 083.
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
                  AND content_ledger_blocks(l.status, l.resource_ref, l.used_at,
                        content_reuse_at(s.reuse_policy, (SELECT r.started_at FROM data_reuse_rounds r
                                                           WHERE r.schema_id = s.id AND r.resource_ref = l.resource_ref)),
                        NULL, 'network', now()))),
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
  END IF;
END $do$;

-- ─── Ending a round ──────────────────────────────────────────────────────────

-- Start the next round of a cycle dataset on one resource when nothing is open any more. VOLATILE, one writer at a time
-- per (dataset, resource): the advisory lock is taken BEFORE the reads, so of two publishes of the last two rows the
-- second one sees the first and rolls. Returns true when a round started.
--   open row = active and data_postable, not done in this round on the resource (published or passed after the round
--              start, by data:// ref or legacy_ref), not error-marked anywhere, not held by an awaiting_approval /
--              approved slot or an awaiting platform post of the resource.
--   rule     = no open row and at least one row done in this round (an empty or all-unpostable dataset never loops).
-- The dataset key is matched with split_part, never LIKE (`_` is a wildcard). The new round starts at clock_timestamp():
-- the row just posted has used_at = now() (the transaction start), so it is open again under the strict `>`.
CREATE OR REPLACE FUNCTION data_round_roll(p_schema_id uuid, p_resource text) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_res      text := NULLIF(btrim(COALESCE(p_resource, '')), '');
  v_key      text;
  v_requires jsonb;
  v_since    timestamptz;
  v_held     text[];
  v_open     boolean;
  v_done     boolean;
BEGIN
  IF v_res IS NULL OR v_res = '*' OR v_res ~ ':\*$' THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('data_round:' || p_schema_id::text || ':' || v_res, 0));

  SELECT s.key, COALESCE(to_jsonb(s) -> 'post_requires', '[]'::jsonb) INTO v_key, v_requires
    FROM data_schemas s WHERE s.id = p_schema_id AND s.reuse_policy->>'kind' = 'cycle';
  IF v_key IS NULL THEN RETURN false; END IF;
  SELECT r.started_at INTO v_since FROM data_reuse_rounds r WHERE r.schema_id = p_schema_id AND r.resource_ref = v_res;

  -- Refs held by a post that waits for the owner on this resource (their library_ref in canonical form).
  SELECT COALESCE(array_agg(DISTINCT content_ref_canonical(h.ref)), '{}') INTO v_held FROM (
    SELECT unnest(ARRAY[sl.post_spec->>'library_ref', sl.platform_spec->>'library_ref']) AS ref
      FROM editor_slots sl
     WHERE sl.status IN ('awaiting_approval', 'approved') AND COALESCE(sl.resource_ref, 'telegram:' || sl.channel_key) = v_res
    UNION ALL
    SELECT pp.source_ref FROM platform_posts pp WHERE pp.resource_ref = v_res AND pp.status = 'awaiting_approval'
  ) h WHERE h.ref IS NOT NULL;

  SELECT EXISTS (
    SELECT 1 FROM data_items d
     WHERE d.schema_id = p_schema_id AND d.status = 'active'
       AND data_postable(v_requires, d.data)
       AND NOT EXISTS (
         SELECT 1 FROM content_ledger l
          WHERE l.source_ref IN ('data://' || v_key || '/' || d.id, d.legacy_ref)
            AND (l.status = 'error'
                 OR (l.resource_ref = v_res AND l.status IN ('published', 'passed') AND (v_since IS NULL OR l.used_at > v_since))))
       AND NOT (('data://' || v_key || '/' || d.id) = ANY (v_held))
  ) INTO v_open;
  IF v_open THEN RETURN false; END IF;

  SELECT EXISTS (
    SELECT 1 FROM content_ledger l
     WHERE l.resource_ref = v_res AND l.status IN ('published', 'passed')
       AND left(l.source_ref, 7) = 'data://' AND split_part(substr(l.source_ref, 8), '/', 1) = v_key
       AND (v_since IS NULL OR l.used_at > v_since)
  ) INTO v_done;
  IF NOT v_done THEN RETURN false; END IF;

  INSERT INTO data_reuse_rounds AS r (schema_id, resource_ref, round, started_at)
  VALUES (p_schema_id, v_res, 2, clock_timestamp())
  ON CONFLICT (schema_id, resource_ref) DO UPDATE SET
    round = r.round + 1, started_at = EXCLUDED.started_at, updated_at = now();
  RETURN true;
END $$;

-- A row nothing can be posted from is done for the round (spec 071 FR-004). Only a data:// row of a cycle dataset is
-- recorded; for every other ref this does nothing. A repeat in a later round moves used_at forward. The ledger trigger
-- below then rolls the round when this was the last open row.
CREATE OR REPLACE FUNCTION content_ledger_pass(
  p_resource text, p_ref text, p_origin text DEFAULT 'editor', p_slot_id uuid DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_ref text := content_ref_canonical(p_ref);
BEGIN
  IF v_ref IS NULL OR left(v_ref, 7) <> 'data://' THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM data_schemas s
                  WHERE s.key = split_part(substr(v_ref, 8), '/', 1) AND s.reuse_policy->>'kind' = 'cycle') THEN
    RETURN false;
  END IF;
  PERFORM content_ledger_record(p_resource, v_ref, p_origin, 'passed', NULL, NULL, p_slot_id, NULL, p_note);
  RETURN true;
END $$;

-- ─── Triggers ────────────────────────────────────────────────────────────────

-- Every writer of a data:// ledger row (the editor, the chat, platform posts, the posted-marker trigger, SQL-only
-- backfills) ends up here: a cycle dataset may have just lost its last open row. Never fails the write.
CREATE OR REPLACE FUNCTION content_ledger_round_after() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT s.id INTO v_id FROM data_schemas s
   WHERE s.key = split_part(substr(NEW.source_ref, 8), '/', 1) AND s.reuse_policy->>'kind' = 'cycle';
  IF v_id IS NOT NULL THEN PERFORM data_round_roll(v_id, NEW.resource_ref); END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'data_round_roll: ledger row % not rolled: %', NEW.id, SQLERRM;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_content_ledger_round ON content_ledger;
CREATE TRIGGER trg_content_ledger_round
  AFTER INSERT OR UPDATE OF used_at ON content_ledger
  FOR EACH ROW WHEN (NEW.source_ref LIKE 'data://%' AND NEW.status IN ('published', 'passed'))
  EXECUTE FUNCTION content_ledger_round_after();

-- A dataset becomes a cycle dataset: start clean (everything published so far is round 1), then roll every resource that
-- has used it all, so a dataset that was used up under `never` (pdr_questions, 866 of 866) is free at once. Only when the
-- kind changes: a change of order / order_by keeps the rounds. Per resource the advisory lock comes first, in the order of
-- data_round_roll, before the rounds row is deleted.
CREATE OR REPLACE FUNCTION data_schemas_reuse_round_after() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_res text;
BEGIN
  FOR v_res IN
    SELECT x.resource_ref FROM (
      SELECT l.resource_ref FROM content_ledger l
       WHERE l.status IN ('published', 'passed') AND left(l.source_ref, 7) = 'data://'
         AND split_part(substr(l.source_ref, 8), '/', 1) = NEW.key
      UNION
      SELECT r.resource_ref FROM data_reuse_rounds r WHERE r.schema_id = NEW.id
    ) x
    WHERE btrim(x.resource_ref) <> '' AND x.resource_ref !~ ':\*$' AND x.resource_ref <> '*'
    ORDER BY x.resource_ref
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('data_round:' || NEW.id::text || ':' || v_res, 0));
    DELETE FROM data_reuse_rounds WHERE schema_id = NEW.id AND resource_ref = v_res;
    PERFORM data_round_roll(NEW.id, v_res);
  END LOOP;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'data_round_roll: dataset % not rolled after the switch to cycle: %', NEW.key, SQLERRM;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_data_schemas_reuse_round ON data_schemas;
CREATE TRIGGER trg_data_schemas_reuse_round
  AFTER UPDATE OF reuse_policy ON data_schemas
  FOR EACH ROW WHEN (NEW.reuse_policy->>'kind' = 'cycle' AND OLD.reuse_policy->>'kind' IS DISTINCT FROM 'cycle')
  EXECUTE FUNCTION data_schemas_reuse_round_after();

INSERT INTO schema_migrations (version) VALUES ('096_data_reuse_rounds') ON CONFLICT (version) DO NOTHING;
