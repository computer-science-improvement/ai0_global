-- 058_data_store.sql — unified data store (spec 032).
--
--   data_schemas           one row per dataset: plain-English description of the data and every field,
--                          the roles mapping (common shape), dedup key, license and reuse policy
--   data_schema_versions   every structural version of a schema (fields, roles, dedup key)
--   data_items             every content row of every dataset: `data` jsonb + an envelope filled from roles
--   data_imports           audit of every import (csv / json / jsonl / pipeline / api) with undo
--   data_import_snapshots  pre-update copy of rows an import changed (undo restores them)
--   data_schema_stats      per-dataset stats for the agent catalog (refreshed after imports)
--
--   data_items_upsert()    THE write path: validate, build external_key, insert or merge, report
--
-- A new dataset is a data_schemas row plus an import; it never needs a migration.
-- Idempotent and transactional (both runners wrap the file in one transaction).

-- ─── Tables ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS data_schemas (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key                    TEXT NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  title                  TEXT NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  entity                 TEXT NOT NULL DEFAULT 'item',
  version                INT  NOT NULL DEFAULT 1,
  fields                 JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(fields) = 'array'),
  roles                  JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(roles) = 'object'),
  dedup_key              TEXT[] NOT NULL DEFAULT '{}',
  language               TEXT,
  default_license        TEXT NOT NULL DEFAULT 'unknown',
  reuse_policy           JSONB NOT NULL DEFAULT '{"kind":"never"}' CHECK (reuse_policy->>'kind' IN ('never','after_days')),
  suitable_for           TEXT NOT NULL DEFAULT '',
  contains_personal_data BOOLEAN NOT NULL DEFAULT false,
  -- Only for the 12 tables moved by this migration: {table, id: 'uuid'|'text', id_field?}.
  -- Rows of such a schema always carry legacy_ref = 'library://<table>/<old id>'.
  legacy                 JSONB,
  status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  created_by             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS data_schema_versions (
  schema_id   UUID NOT NULL REFERENCES data_schemas(id) ON DELETE CASCADE,
  version     INT  NOT NULL,
  fields      JSONB NOT NULL,
  roles       JSONB NOT NULL,
  dedup_key   TEXT[] NOT NULL DEFAULT '{}',
  changed_by  TEXT,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (schema_id, version)
);

CREATE TABLE IF NOT EXISTS data_imports (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_id      UUID NOT NULL REFERENCES data_schemas(id) ON DELETE CASCADE,
  schema_version INT  NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('csv','json','jsonl','pipeline','api')),
  filename       TEXT,
  mapping        JSONB NOT NULL DEFAULT '{}',
  options        JSONB NOT NULL DEFAULT '{}',
  rows_total     INT NOT NULL DEFAULT 0,
  inserted       INT NOT NULL DEFAULT 0,
  updated        INT NOT NULL DEFAULT 0,
  skipped        INT NOT NULL DEFAULT 0,
  invalid        INT NOT NULL DEFAULT 0,
  duplicates     INT NOT NULL DEFAULT 0,
  errors         JSONB NOT NULL DEFAULT '[]',
  preview        JSONB NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'running'
                 CHECK (status IN ('dry_run','running','committed','failed','undone','expired')),
  undo_report    JSONB,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  undone_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_data_imports_schema ON data_imports (schema_id, created_at DESC);

CREATE TABLE IF NOT EXISTS data_items (
  id             BIGSERIAL PRIMARY KEY,
  schema_id      UUID NOT NULL REFERENCES data_schemas(id),
  schema_version INT  NOT NULL,
  external_key   TEXT NOT NULL,
  data           JSONB NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  -- Envelope: filled from the schema's roles by data_items_envelope() on every write.
  title          TEXT,
  body           TEXT,
  image_url      TEXT,
  url            TEXT,
  category       TEXT,
  lang           TEXT,
  event_date     DATE,
  event_month    SMALLINT,
  event_day      SMALLINT,
  license        TEXT,
  source_name    TEXT,
  source_url     TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden')),
  legacy_ref     TEXT UNIQUE,
  -- Transition only (spec 023 FR-010 moves dedup to the content ledger, then this column is dropped).
  posted         JSONB NOT NULL DEFAULT '{}',
  import_id      UUID REFERENCES data_imports(id) ON DELETE SET NULL,
  search         TSVECTOR GENERATED ALWAYS AS (
                   to_tsvector('simple'::regconfig, left(coalesce(title, '') || ' ' || coalesce(body, ''), 200000))
                 ) STORED,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (schema_id, external_key)
);
CREATE INDEX IF NOT EXISTS idx_data_items_schema_status  ON data_items (schema_id, status);
CREATE INDEX IF NOT EXISTS idx_data_items_schema_cat     ON data_items (schema_id, category);
CREATE INDEX IF NOT EXISTS idx_data_items_schema_md      ON data_items (schema_id, event_month, event_day);
CREATE INDEX IF NOT EXISTS idx_data_items_schema_created ON data_items (schema_id, created_at);
CREATE INDEX IF NOT EXISTS idx_data_items_import         ON data_items (import_id) WHERE import_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_data_items_search         ON data_items USING gin (search);
CREATE INDEX IF NOT EXISTS idx_data_items_data           ON data_items USING gin (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS data_import_snapshots (
  import_id      UUID   NOT NULL REFERENCES data_imports(id) ON DELETE CASCADE,
  item_id        BIGINT NOT NULL REFERENCES data_items(id) ON DELETE CASCADE,
  data           JSONB  NOT NULL,
  schema_version INT    NOT NULL,
  PRIMARY KEY (import_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_data_import_snapshots_item ON data_import_snapshots (item_id);

CREATE TABLE IF NOT EXISTS data_schema_stats (
  schema_id        UUID PRIMARY KEY REFERENCES data_schemas(id) ON DELETE CASCADE,
  rows_total       BIGINT NOT NULL DEFAULT 0,
  rows_active      BIGINT NOT NULL DEFAULT 0,
  rows_hidden      BIGINT NOT NULL DEFAULT 0,
  unposted_network BIGINT NOT NULL DEFAULT 0,
  today_items      BIGINT NOT NULL DEFAULT 0,
  top_categories   JSONB NOT NULL DEFAULT '[]',
  fill_rate        JSONB NOT NULL DEFAULT '{}',
  broken_image_pct NUMERIC,
  last_import_at   TIMESTAMPTZ,
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Small helpers ───────────────────────────────────────────────────────────

-- Drop top-level keys whose value is JSON null (nested nulls are data and stay).
CREATE OR REPLACE FUNCTION data_strip_top_nulls(p jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    FROM jsonb_each(p) e
   WHERE jsonb_typeof(e.value) <> 'null'
$$;

-- external_key = dedup field values joined with '|' and lower-cased; NULL when no dedup key
-- or when every part is empty.
CREATE OR REPLACE FUNCTION data_external_key(p_keys text[], p_data jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN cardinality(p_keys) = 0 THEN NULL
    WHEN NOT EXISTS (SELECT 1 FROM unnest(p_keys) k WHERE COALESCE(p_data->>k, '') <> '') THEN NULL
    ELSE lower(array_to_string(ARRAY(
           SELECT COALESCE(p_data->>k, '') FROM unnest(p_keys) WITH ORDINALITY u(k, n) ORDER BY n), '|'))
  END
$$;

-- A role maps to one field name, or to a list of names (first non-blank value wins).
CREATE OR REPLACE FUNCTION data_role_value(p_roles jsonb, p_role text, p_data jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE jsonb_typeof(p_roles->p_role)
    WHEN 'string' THEN NULLIF(p_data->>(p_roles->>p_role), '')
    WHEN 'array'  THEN (SELECT p_data->>f
                          FROM jsonb_array_elements_text(p_roles->p_role) WITH ORDINALITY e(f, n)
                         WHERE COALESCE(btrim(p_data->>f), '') <> ''
                         ORDER BY n LIMIT 1)
  END
$$;

CREATE OR REPLACE FUNCTION data_try_date(p text) RETURNS date
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p IS NULL OR p !~ '^\d{4}-\d{2}-\d{2}' THEN RETURN NULL; END IF;
  RETURN left(p, 10)::date;
EXCEPTION WHEN others THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION data_small_int(p text, p_max int) RETURNS smallint
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN btrim(p) ~ '^\d{1,2}$' AND btrim(p)::int BETWEEN 1 AND p_max THEN btrim(p)::smallint END
$$;

-- Structure of a field definition = everything except the descriptive keys. A change here is structural.
CREATE OR REPLACE FUNCTION data_field_structure(f jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT f - 'description' - 'example' - 'agent_visible' - 'searchable' - 'filterable' - 'since_version'
$$;

-- ─── Schema validation and versioning ────────────────────────────────────────

CREATE OR REPLACE FUNCTION data_schema_check(p_fields jsonb, p_roles jsonb, p_dedup text[]) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  f      jsonb;
  v_names text[] := '{}';
  r      record;
  v      text;
BEGIN
  IF jsonb_typeof(p_fields) <> 'array' THEN RAISE EXCEPTION 'fields must be a JSON array'; END IF;
  FOR f IN SELECT e FROM jsonb_array_elements(p_fields) e LOOP
    IF jsonb_typeof(f) <> 'object' OR COALESCE(f->>'name', '') !~ '^[a-z][a-z0-9_]{0,62}$' THEN
      RAISE EXCEPTION 'field name must be snake_case (a-z, 0-9, _): %', COALESCE(f->>'name', f::text);
    END IF;
    IF (f->>'name') = ANY (v_names) THEN RAISE EXCEPTION 'duplicate field name: %', f->>'name'; END IF;
    IF COALESCE(f->>'type', '') NOT IN ('text','long_text','int','number','bool','date','datetime','month_day',
                                         'url','image_url','enum','text_list','json') THEN
      RAISE EXCEPTION 'field %: unknown type %', f->>'name', COALESCE(f->>'type', '(missing)');
    END IF;
    IF f->>'type' = 'enum' AND (jsonb_typeof(f->'enum') IS DISTINCT FROM 'array' OR jsonb_array_length(f->'enum') = 0) THEN
      RAISE EXCEPTION 'field %: an enum needs a non-empty list of values', f->>'name';
    END IF;
    v_names := v_names || (f->>'name');
  END LOOP;

  IF jsonb_typeof(p_roles) <> 'object' THEN RAISE EXCEPTION 'roles must be a JSON object'; END IF;
  FOR r IN SELECT key, value FROM jsonb_each(p_roles) LOOP
    IF r.key NOT IN ('title','body','image','url','category','date','month_day','month','day','lang',
                     'source_name','source_url','license') THEN
      RAISE EXCEPTION 'unknown role: %', r.key;
    END IF;
    IF jsonb_typeof(r.value) = 'string' THEN
      IF NOT (r.value #>> '{}') = ANY (v_names) THEN RAISE EXCEPTION 'role % points to unknown field %', r.key, r.value #>> '{}'; END IF;
    ELSIF jsonb_typeof(r.value) = 'array' AND jsonb_array_length(r.value) > 0 THEN
      FOR v IN SELECT jsonb_array_elements_text(r.value) LOOP
        IF NOT v = ANY (v_names) THEN RAISE EXCEPTION 'role % points to unknown field %', r.key, v; END IF;
      END LOOP;
    ELSE
      RAISE EXCEPTION 'role % must be a field name or a list of field names', r.key;
    END IF;
  END LOOP;

  FOREACH v IN ARRAY COALESCE(p_dedup, '{}') LOOP
    IF NOT v = ANY (v_names) THEN RAISE EXCEPTION 'dedup_key points to unknown field %', v; END IF;
  END LOOP;
END $$;

-- Description-only edits keep the version; structural edits (new field, deprecation, required/default/enum
-- change, roles, dedup key) bump it and write data_schema_versions. Fields are never removed, renamed or
-- retyped in place, so every stored row stays valid. Who/why come from the session settings
-- data_store.changed_by / data_store.reason (set by DataStore).
CREATE OR REPLACE FUNCTION data_schemas_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o           jsonb;
  n           jsonb;
  v_struct    boolean := false;
BEGIN
  PERFORM data_schema_check(NEW.fields, NEW.roles, NEW.dedup_key);
  IF TG_OP = 'INSERT' THEN
    NEW.version := 1;
    RETURN NEW;
  END IF;

  FOR o IN SELECT e FROM jsonb_array_elements(OLD.fields) e LOOP
    SELECT e INTO n FROM jsonb_array_elements(NEW.fields) e WHERE e->>'name' = o->>'name';
    IF n IS NULL THEN
      RAISE EXCEPTION 'field "%" cannot be removed or renamed; mark it deprecated instead', o->>'name';
    END IF;
    IF n->>'type' IS DISTINCT FROM o->>'type' THEN
      RAISE EXCEPTION 'type of field "%" cannot change (% to %); add a new field and deprecate this one',
        o->>'name', o->>'type', n->>'type';
    END IF;
    IF o->>'type' = 'enum' AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(o->'enum') ov WHERE NOT (n->'enum') @> jsonb_build_array(ov)) THEN
      RAISE EXCEPTION 'enum values of field "%" can only be added, not removed', o->>'name';
    END IF;
    IF data_field_structure(n) IS DISTINCT FROM data_field_structure(o) THEN v_struct := true; END IF;
  END LOOP;
  IF jsonb_array_length(NEW.fields) > jsonb_array_length(OLD.fields) THEN v_struct := true; END IF;
  IF NEW.roles IS DISTINCT FROM OLD.roles THEN v_struct := true; END IF;
  IF NEW.dedup_key IS DISTINCT FROM OLD.dedup_key THEN
    IF EXISTS (SELECT 1 FROM data_items WHERE schema_id = OLD.id) THEN
      RAISE EXCEPTION 'dedup_key of "%" cannot change once the dataset has rows', OLD.key;
    END IF;
    v_struct := true;
  END IF;

  NEW.version := OLD.version;            -- callers never set the version directly
  IF v_struct THEN
    NEW.version := OLD.version + 1;
  END IF;
  -- Carry since_version over; stamp it on fields added by this version.
  SELECT jsonb_agg(
           CASE
             WHEN ov.e IS NOT NULL AND ov.e ? 'since_version' THEN ne.e || jsonb_build_object('since_version', ov.e->'since_version')
             WHEN ov.e IS NOT NULL THEN ne.e - 'since_version'
             ELSE ne.e || jsonb_build_object('since_version', NEW.version)
           END ORDER BY ne.o)
    INTO NEW.fields
    FROM jsonb_array_elements(NEW.fields) WITH ORDINALITY ne(e, o)
    LEFT JOIN LATERAL (SELECT x AS e FROM jsonb_array_elements(OLD.fields) x WHERE x->>'name' = ne.e->>'name') ov ON true;
  NEW.fields := COALESCE(NEW.fields, '[]'::jsonb);

  IF v_struct THEN
    INSERT INTO data_schema_versions (schema_id, version, fields, roles, dedup_key, changed_by, reason)
    VALUES (NEW.id, NEW.version, NEW.fields, NEW.roles, NEW.dedup_key,
            NULLIF(current_setting('data_store.changed_by', true), ''),
            NULLIF(current_setting('data_store.reason', true), ''));
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION data_schemas_after() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO data_schema_versions (schema_id, version, fields, roles, dedup_key, changed_by, reason)
    VALUES (NEW.id, NEW.version, NEW.fields, NEW.roles, NEW.dedup_key,
            COALESCE(NULLIF(current_setting('data_store.changed_by', true), ''), NEW.created_by),
            COALESCE(NULLIF(current_setting('data_store.reason', true), ''), 'created'))
    ON CONFLICT DO NOTHING;
  ELSIF NEW.roles IS DISTINCT FROM OLD.roles
     OR NEW.language IS DISTINCT FROM OLD.language
     OR NEW.default_license IS DISTINCT FROM OLD.default_license THEN
    -- Re-fill the envelope of every row from the new roles.
    UPDATE data_items SET data = data WHERE schema_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS data_schemas_guard ON data_schemas;
CREATE TRIGGER data_schemas_guard BEFORE INSERT OR UPDATE ON data_schemas
  FOR EACH ROW EXECUTE FUNCTION data_schemas_guard();
DROP TRIGGER IF EXISTS data_schemas_after ON data_schemas;
CREATE TRIGGER data_schemas_after AFTER INSERT OR UPDATE ON data_schemas
  FOR EACH ROW EXECUTE FUNCTION data_schemas_after();

-- ─── Envelope ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION data_items_envelope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s   record;
  v   text;
BEGIN
  SELECT roles, language, default_license INTO s FROM data_schemas WHERE id = NEW.schema_id;
  NEW.title       := data_role_value(s.roles, 'title', NEW.data);
  NEW.body        := data_role_value(s.roles, 'body', NEW.data);
  NEW.image_url   := data_role_value(s.roles, 'image', NEW.data);
  NEW.url         := data_role_value(s.roles, 'url', NEW.data);
  NEW.category    := data_role_value(s.roles, 'category', NEW.data);
  NEW.lang        := COALESCE(data_role_value(s.roles, 'lang', NEW.data), s.language);
  NEW.license     := COALESCE(data_role_value(s.roles, 'license', NEW.data), s.default_license, 'unknown');
  NEW.source_name := data_role_value(s.roles, 'source_name', NEW.data);
  NEW.source_url  := data_role_value(s.roles, 'source_url', NEW.data);
  NEW.event_date  := data_try_date(data_role_value(s.roles, 'date', NEW.data));
  v := data_role_value(s.roles, 'month_day', NEW.data);
  IF v ~ '^\d{2}-\d{2}$' THEN
    NEW.event_month := data_small_int(split_part(v, '-', 1), 12);
    NEW.event_day   := data_small_int(split_part(v, '-', 2), 31);
  ELSE
    NEW.event_month := data_small_int(data_role_value(s.roles, 'month', NEW.data), 12);
    NEW.event_day   := data_small_int(data_role_value(s.roles, 'day', NEW.data), 31);
  END IF;
  IF NEW.event_month IS NULL AND NEW.event_date IS NOT NULL THEN
    NEW.event_month := EXTRACT(MONTH FROM NEW.event_date)::smallint;
    NEW.event_day   := EXTRACT(DAY FROM NEW.event_date)::smallint;
  END IF;
  IF TG_OP = 'UPDATE' THEN NEW.updated_at := now(); END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS data_items_envelope ON data_items;
CREATE TRIGGER data_items_envelope BEFORE INSERT OR UPDATE OF data, schema_id ON data_items
  FOR EACH ROW EXECUTE FUNCTION data_items_envelope();

-- ─── Value normalisation (basic types; the automation side validates strictly with zod first) ──

CREATE OR REPLACE FUNCTION data_normalize_value(p_field jsonb, p_val jsonb, OUT val jsonb, OUT err text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  t text := p_field->>'type';
  k text := jsonb_typeof(p_val);
  s text;
BEGIN
  val := p_val;
  err := NULL;
  IF p_val IS NULL OR k = 'null' THEN val := 'null'::jsonb; RETURN; END IF;
  IF k = 'string' THEN s := p_val #>> '{}'; END IF;

  IF t IN ('text','long_text','url','image_url') THEN
    IF k IN ('number','boolean') THEN val := to_jsonb(p_val #>> '{}');
    ELSIF k <> 'string' THEN err := 'expected text';
    END IF;
  ELSIF t = 'int' THEN
    IF k = 'number' THEN
      IF (p_val #>> '{}')::numeric <> trunc((p_val #>> '{}')::numeric) THEN err := 'expected an integer'; END IF;
    ELSIF k = 'string' AND btrim(s) ~ '^[+-]?\d{1,18}$' THEN
      val := to_jsonb(btrim(s)::bigint);
    ELSE
      err := 'expected an integer';
    END IF;
  ELSIF t = 'number' THEN
    IF k = 'number' THEN NULL;
    ELSIF k = 'string' AND btrim(s) ~ '^[+-]?(\d+([.,]\d*)?|[.,]\d+)([eE][+-]?\d+)?$' THEN
      val := to_jsonb(replace(btrim(s), ',', '.')::numeric);
    ELSE
      err := 'expected a number';
    END IF;
  ELSIF t = 'bool' THEN
    IF k = 'boolean' THEN NULL;
    ELSIF k = 'string' AND lower(btrim(s)) IN ('true','false','t','f','1','0','yes','no') THEN
      val := to_jsonb(lower(btrim(s)) IN ('true','t','1','yes'));
    ELSIF k = 'number' AND (p_val #>> '{}') IN ('0','1') THEN
      val := to_jsonb((p_val #>> '{}') = '1');
    ELSE
      err := 'expected true or false';
    END IF;
  ELSIF t = 'date' THEN
    IF k = 'string' AND s ~ '^\d{4}-\d{2}-\d{2}$' AND data_try_date(s) IS NOT NULL THEN NULL;
    ELSE err := 'expected a date YYYY-MM-DD';
    END IF;
  ELSIF t = 'datetime' THEN
    IF k = 'string' AND s ~ '^\d{4}-\d{2}-\d{2}' THEN
      BEGIN
        PERFORM s::timestamptz;
      EXCEPTION WHEN others THEN
        err := 'expected an ISO date-time';
      END;
    ELSE
      err := 'expected an ISO date-time';
    END IF;
  ELSIF t = 'month_day' THEN
    IF NOT (k = 'string' AND s ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$') THEN err := 'expected MM-DD'; END IF;
  ELSIF t = 'enum' THEN
    IF k NOT IN ('string','number') OR NOT (COALESCE(p_field->'enum', '[]'::jsonb) @> jsonb_build_array(p_val #>> '{}')) THEN
      err := 'not one of the allowed values';
    ELSE
      val := to_jsonb(p_val #>> '{}');
    END IF;
  ELSIF t = 'text_list' THEN
    IF k <> 'array' OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_val) e WHERE jsonb_typeof(e) NOT IN ('string','number','boolean')) THEN
      err := 'expected a list of strings';
    ELSE
      val := COALESCE((SELECT jsonb_agg(e #>> '{}' ORDER BY o) FROM jsonb_array_elements(p_val) WITH ORDINALITY x(e, o)), '[]'::jsonb);
    END IF;
  ELSIF t = 'json' THEN
    NULL;
  ELSE
    err := 'unknown field type ' || COALESCE(t, '(missing)');
  END IF;
END $$;

-- Normalise one incoming row against the schema: {data, errors, key}. `data` keeps explicit JSON nulls
-- (a merge clears those fields); `key` is the external key the row resolves to (defaults applied).
CREATE OR REPLACE FUNCTION data_prepare_row(p_schema data_schemas, p_row jsonb, p_row_no int)
RETURNS TABLE (data jsonb, errors jsonb, key text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  f       jsonb;
  k       text;
  v_val   jsonb;
  v_err   text;
  v_names text[];
  v_defs  jsonb;
BEGIN
  data := '{}'::jsonb;
  errors := '[]'::jsonb;
  IF p_row IS NULL OR jsonb_typeof(p_row) <> 'object' THEN
    errors := jsonb_build_array(jsonb_build_object('row', p_row_no, 'field', NULL, 'error', 'row is not an object'));
    RETURN NEXT; RETURN;
  END IF;
  SELECT array_agg(e->>'name'), COALESCE(jsonb_object_agg(e->>'name', e->'default') FILTER (WHERE e ? 'default'), '{}'::jsonb)
    INTO v_names, v_defs FROM jsonb_array_elements(p_schema.fields) e;
  FOR k IN SELECT jsonb_object_keys(p_row) LOOP
    IF NOT (k = ANY (COALESCE(v_names, '{}'))) AND k NOT IN ('_external_key','_legacy_ref','_posted','_extra') THEN
      errors := errors || jsonb_build_object('row', p_row_no, 'field', k, 'error', 'unknown field');
    END IF;
  END LOOP;
  FOR f IN SELECT e FROM jsonb_array_elements(p_schema.fields) e LOOP
    k := f->>'name';
    IF p_row ? k THEN
      SELECT n.val, n.err INTO v_val, v_err FROM data_normalize_value(f, p_row->k) n;
      IF v_err IS NOT NULL THEN
        errors := errors || jsonb_build_object('row', p_row_no, 'field', k, 'error', v_err);
      ELSE
        data := data || jsonb_build_object(k, v_val);
      END IF;
    END IF;
  END LOOP;
  IF p_row ? '_extra' AND jsonb_typeof(p_row->'_extra') <> 'null' THEN
    data := data || jsonb_build_object('_extra', p_row->'_extra');
  END IF;
  key := COALESCE(NULLIF(p_row->>'_external_key', ''),
                  data_external_key(p_schema.dedup_key, v_defs || data_strip_top_nulls(data)));
  RETURN NEXT;
END $$;

-- ─── The write path ──────────────────────────────────────────────────────────
-- data_items_upsert(schema_key, rows jsonb array, import_id, update_fields)
--   • a row is matched by `_legacy_ref` (rows of moved tables), else by external_key
--     (`_external_key` wins over the dedup_key fields);
--   • new rows: defaults filled, required fields checked, inserted (with `_posted` / `_legacy_ref`);
--   • existing rows: only `p_update_fields` (every provided field when NULL; nothing when '{}') are merged;
--     a JSON null clears a field; an unchanged row counts as skipped;
--   • with p_import_id, inserted rows carry it and updated rows are snapshotted for undo.
-- Returns {inserted, updated, skipped, invalid: [{row, field, error}], invalid_rows}. `row` is 0-based.
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

-- Keys the rows of a batch resolve to, and whether a row with that key already exists (import dry run).
CREATE OR REPLACE FUNCTION data_items_preview_keys(p_schema_key text, p_rows jsonb)
RETURNS TABLE (row_no int, external_key text, item_exists boolean)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  s data_schemas%ROWTYPE;
BEGIN
  SELECT * INTO s FROM data_schemas WHERE key = p_schema_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown data schema "%"', p_schema_key USING ERRCODE = 'no_data_found'; END IF;
  RETURN QUERY
    SELECT (x.o - 1)::int, pr.key,
           EXISTS (SELECT 1 FROM data_items d WHERE d.schema_id = s.id AND d.external_key = pr.key)
      FROM jsonb_array_elements(p_rows) WITH ORDINALITY x(e, o)
      CROSS JOIN LATERAL data_prepare_row(s, x.e, (x.o - 1)::int) pr;
END $$;

-- ─── Stats (catalog; refreshed after every import, nightly by spec 032 T6) ────

CREATE OR REPLACE FUNCTION data_schema_stats_refresh(p_schema_id uuid DEFAULT NULL) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  s       record;
  v_n     int := 0;
  v_month smallint := EXTRACT(MONTH FROM (now() AT TIME ZONE 'Europe/Kyiv'))::smallint;
  v_day   smallint := EXTRACT(DAY   FROM (now() AT TIME ZONE 'Europe/Kyiv'))::smallint;
BEGIN
  FOR s IN SELECT id FROM data_schemas WHERE p_schema_id IS NULL OR id = p_schema_id LOOP
    INSERT INTO data_schema_stats AS t (schema_id, rows_total, rows_active, rows_hidden, unposted_network,
                                        today_items, top_categories, fill_rate, last_import_at, computed_at)
    SELECT s.id,
           count(*),
           count(*) FILTER (WHERE d.status = 'active'),
           count(*) FILTER (WHERE d.status = 'hidden'),
           count(*) FILTER (WHERE d.status = 'active' AND NOT EXISTS (
               SELECT 1 FROM jsonb_object_keys(d.posted) k WHERE k NOT LIKE 'error:%')),
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

-- ═══ One-time move of the 12 content tables (spec 032 FR-008) ════════════════
--
-- For each of recipes, facts, quotes, prompts, on_this_day, articles, pdr_questions, birthdays, assets,
-- tg_posts, jokes and name_days:
--   1. seed its schema (curated plain-English descriptions; any real column the list misses is added
--      automatically, so a drifted production table still moves losslessly);
--   2. copy every row into data_items with legacy_ref = 'library://<table>/<id>', keeping posted,
--      created_at, license and source_name;
--   3. check parity (row counts), rename the table to legacy_<table> (read-only from now on);
--   4. create a compatibility VIEW with the old name, the same columns, types, order and ids, plus
--      INSTEAD OF triggers that route INSERT / UPDATE / DELETE into the store;
--   5. compare every legacy row with its view row (EXCEPT ALL); any difference rolls the migration back.
-- Re-running is a no-op: a table that is already a view next to legacy_<table> is skipped.
-- Rollback for 30 days: legacy_<table> still has every row as it was at the move.

CREATE OR REPLACE FUNCTION data_legacy_readonly() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is read-only since migration 058; write through the "%" view or the data store',
    TG_TABLE_NAME, substr(TG_TABLE_NAME, 8) USING ERRCODE = 'read_only_sql_transaction';
END $$;

-- INSTEAD OF trigger on a compatibility view. TG_ARGV[0] = schema key (= old table name),
-- TG_ARGV[1] = id kind ('uuid': the old uuid lives only in legacy_ref; 'text': `id` is a data field).
--   INSERT  → data_items_upsert(..., update_fields => '{}'): a new row is inserted, an existing dedup key is
--             skipped (the old loaders' ON CONFLICT DO NOTHING); RETURNING sees the id.
--   UPDATE  → changed data columns go through data_items_upsert(..., update_fields => changed);
--             `posted` is applied as a delta on the current value (no lost update between two writers).
--   DELETE  → deletes the store row.
CREATE OR REPLACE FUNCTION data_legacy_view_write() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_key     text := TG_ARGV[0];
  v_kind    text := TG_ARGV[1];
  v_prefix  text := 'library://' || TG_ARGV[0] || '/';
  v_new     jsonb;
  v_old     jsonb;
  v_row     jsonb;
  v_res     jsonb;
  v_lid     text;
  v_ref     text;
  v_changed text[];
  v_item    bigint;
  v_created timestamptz;
  v_add     jsonb;
  v_del     text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW);
    v_lid := CASE WHEN v_kind = 'uuid' THEN COALESCE(v_new->>'id', gen_random_uuid()::text) ELSE v_new->>'id' END;
    IF COALESCE(v_lid, '') = '' THEN
      RAISE EXCEPTION 'null value in column "id" of relation "%"', TG_TABLE_NAME USING ERRCODE = 'not_null_violation';
    END IF;
    v_ref := v_prefix || v_lid;
    v_row := v_new - 'posted' - 'created_at';
    IF v_kind = 'uuid' THEN v_row := v_row - 'id'; END IF;
    v_row := data_strip_top_nulls(v_row)
             || jsonb_build_object('_legacy_ref', v_ref, '_posted', COALESCE(v_new->'posted', '{}'::jsonb));
    v_res := data_items_upsert(v_key, jsonb_build_array(v_row), NULL, ARRAY[]::text[]);
    IF jsonb_array_length(v_res->'invalid') > 0 THEN
      RAISE EXCEPTION '%: invalid row: %', TG_TABLE_NAME, v_res->'invalid' USING ERRCODE = 'check_violation';
    END IF;
    IF (v_res->>'inserted')::int = 0 THEN RETURN NULL; END IF;
    SELECT created_at INTO v_created FROM data_items WHERE legacy_ref = v_ref;
    NEW.id := v_lid;
    NEW.created_at := v_created;
    RETURN NEW;
  END IF;

  v_old := to_jsonb(OLD);
  v_ref := v_prefix || (v_old->>'id');
  SELECT id INTO v_item FROM data_items WHERE legacy_ref = v_ref;
  IF v_item IS NULL THEN RETURN NULL; END IF;

  IF TG_OP = 'DELETE' THEN
    DELETE FROM data_items WHERE id = v_item;
    RETURN OLD;
  END IF;

  v_new := to_jsonb(NEW);
  IF v_new->'id' IS DISTINCT FROM v_old->'id' THEN
    RAISE EXCEPTION '%: id cannot change', TG_TABLE_NAME USING ERRCODE = 'feature_not_supported';
  END IF;
  SELECT array_agg(k) INTO v_changed
    FROM jsonb_object_keys(v_new) k
   WHERE k NOT IN ('id', 'posted', 'created_at') AND v_new->k IS DISTINCT FROM v_old->k;
  IF v_changed IS NOT NULL THEN
    SELECT jsonb_object_agg(k, v_new->k) INTO v_row FROM unnest(v_changed) k;
    v_res := data_items_upsert(v_key, jsonb_build_array(v_row || jsonb_build_object('_legacy_ref', v_ref)), NULL, v_changed);
    IF jsonb_array_length(v_res->'invalid') > 0 THEN
      RAISE EXCEPTION '%: invalid update: %', TG_TABLE_NAME, v_res->'invalid' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF v_new->'posted' IS DISTINCT FROM v_old->'posted' THEN
    SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb) INTO v_add
      FROM jsonb_each(COALESCE(v_new->'posted', '{}'::jsonb)) e
     WHERE (v_old->'posted'->e.key) IS DISTINCT FROM e.value;
    SELECT array_agg(k) INTO v_del
      FROM jsonb_object_keys(COALESCE(v_old->'posted', '{}'::jsonb)) k
     WHERE NOT COALESCE(v_new->'posted', '{}'::jsonb) ? k;
    UPDATE data_items SET posted = (posted - COALESCE(v_del, '{}'::text[])) || v_add WHERE id = v_item;
  END IF;
  IF v_new->'created_at' IS DISTINCT FROM v_old->'created_at' THEN
    UPDATE data_items SET created_at = (v_new->>'created_at')::timestamptz WHERE id = v_item;
  END IF;
  RETURN NEW;
END $$;

DO $move$
DECLARE
  v_common jsonb := $common$[
    {"name": "source_name", "type": "text", "filterable": true, "agent_visible": true,
     "description": "Site or dataset the row came from, e.g. faktypro.com.ua. Credit it when the license is unknown."},
    {"name": "source_url", "type": "url", "agent_visible": true,
     "description": "Canonical URL of the original, when known."},
    {"name": "license", "type": "enum", "required": true, "default": "unknown", "filterable": true, "agent_visible": true,
     "enum": ["unknown", "permitted", "own", "cc-by", "pd"],
     "description": "Reuse license. unknown: write original text and credit the source; permitted: the owner has permission; own: our own content; cc-by: reuse with credit; pd: public domain."}
  ]$common$::jsonb;
  v_defs jsonb := $defs$ {
  "recipes": {
    "title": "Recipes", "entity": "recipe", "language": "en",
    "description": "International recipes from public recipe datasets (mostly English), with per-serving nutrition. The recipes channel translates a recipe into Ukrainian on first post and caches the translation on the row.",
    "suitable_for": "Food and cooking channels: recipe posts, carousels with calories and macros, menu ideas.",
    "dedup_key": ["slug"],
    "roles": {"title": ["title_uk", "title"], "body": ["description", "ingredients_uk", "ingredients"], "image": "image_url", "url": "url", "category": "category"},
    "fields": [
      {"name": "title", "type": "text", "required": true, "searchable": true, "description": "Original recipe name as the source published it (usually English)."},
      {"name": "slug", "type": "text", "required": true, "agent_visible": false, "description": "URL-safe unique id of the recipe; the dedup key."},
      {"name": "url", "type": "url", "description": "Link to the original recipe page."},
      {"name": "description", "type": "long_text", "searchable": true, "description": "Short intro or summary of the dish from the source."},
      {"name": "ingredients", "type": "long_text", "searchable": true, "description": "Ingredient list in the source language, one item per line."},
      {"name": "instructions", "type": "long_text", "description": "Cooking steps in the source language."},
      {"name": "image_url", "type": "image_url", "description": "Photo of the finished dish."},
      {"name": "category", "type": "text", "filterable": true, "description": "Dish category from the source, e.g. dessert or soup."},
      {"name": "tags", "type": "text_list", "filterable": true, "description": "Free-form tags from the source."},
      {"name": "post_text", "type": "long_text", "agent_visible": false, "description": "Legacy pre-written post text; usually empty."},
      {"name": "title_uk", "type": "text", "searchable": true, "description": "Ukrainian title, filled when the recipe is first translated. An empty string means the translator refused the recipe: skip it."},
      {"name": "ingredients_uk", "type": "long_text", "description": "Ukrainian ingredient list (filled with title_uk)."},
      {"name": "instructions_uk", "type": "long_text", "description": "Ukrainian cooking steps (filled with title_uk)."},
      {"name": "translated_at", "type": "datetime", "agent_visible": false, "description": "When the Ukrainian translation was cached."},
      {"name": "telegraph_url", "type": "url", "description": "Telegraph page with the full recipe, created once on the first Telegram post."},
      {"name": "telegraph_path", "type": "text", "agent_visible": false, "description": "Path of the Telegraph page (used to edit it)."},
      {"name": "kcal", "type": "number", "filterable": true, "description": "Calories per serving."},
      {"name": "protein_g", "type": "number", "description": "Protein per serving, grams."},
      {"name": "fat_g", "type": "number", "description": "Total fat per serving, grams."},
      {"name": "carbs_g", "type": "number", "description": "Total carbohydrates per serving, grams."},
      {"name": "serving_size_g", "type": "number", "description": "Serving size, grams."},
      {"name": "raw", "type": "json", "agent_visible": false, "description": "Full original record from the source dataset (detailed nutrition, servings, notes, techniques)."}
    ]
  },
  "facts": {
    "title": "Interesting facts", "entity": "fact", "language": "uk",
    "description": "Short interesting facts in Ukrainian, one fact per row, collected from faktypro.com.ua articles. Facts of one article share its title, link and image.",
    "suitable_for": "General-interest, science and 'did you know' channels: single-fact posts, fact series on one topic.",
    "dedup_key": ["content_hash"],
    "roles": {"title": "article_title", "body": "content", "image": "image_url", "url": "article_url", "category": "category"},
    "fields": [
      {"name": "article_slug", "type": "text", "required": true, "agent_visible": false, "filterable": true, "description": "Slug of the source article; groups the facts of one article."},
      {"name": "article_title", "type": "text", "required": true, "searchable": true, "description": "Title of the source article, i.e. the topic of the fact."},
      {"name": "article_url", "type": "url", "description": "Link to the source article."},
      {"name": "image_url", "type": "image_url", "description": "Illustration of the source article."},
      {"name": "content", "type": "long_text", "required": true, "searchable": true, "description": "The fact itself: one paragraph in Ukrainian."},
      {"name": "content_hash", "type": "text", "required": true, "agent_visible": false, "description": "MD5 of content; the dedup key."},
      {"name": "category", "type": "text", "filterable": true, "description": "Topic category of the source article."}
    ]
  },
  "quotes": {
    "title": "Quotes", "entity": "quote", "language": "uk",
    "description": "Quotes in Ukrainian with their authors, collected from daytoday.ua and cleaned of numbering and quote marks.",
    "suitable_for": "Motivation and self-development channels: quote of the day, quote cards, quotes by birthday people.",
    "dedup_key": ["text_hash"],
    "roles": {"title": "author", "body": "text", "url": "url", "category": "category"},
    "fields": [
      {"name": "text", "type": "long_text", "required": true, "searchable": true, "description": "The quote itself."},
      {"name": "text_hash", "type": "text", "required": true, "agent_visible": false, "description": "MD5 of text; the dedup key."},
      {"name": "author", "type": "text", "filterable": true, "searchable": true, "description": "Who said or wrote it; may be empty."},
      {"name": "category", "type": "text", "filterable": true, "description": "Theme of the quote collection."},
      {"name": "url", "type": "url", "description": "Page the quote was collected from."}
    ]
  },
  "prompts": {
    "title": "AI image and video prompts", "entity": "prompt", "language": "en",
    "description": "Prompts for image and video generators. PromptHero rows (provider prompthero) store only the page link and image; the prompt text is scraped at post time. Curated GitHub rows (other providers) store the full prompt text and an example output.",
    "suitable_for": "AI art and prompt-engineering channels: prompt of the day with the example image or video.",
    "dedup_key": ["id"],
    "roles": {"title": "title", "body": "prompt_text", "image": "media_url", "url": "page_url", "category": "category"},
    "fields": [
      {"name": "id", "type": "text", "required": true, "agent_visible": false, "description": "Stable id: the image CDN URL for PromptHero rows, a curated id for GitHub prompts. The dedup key."},
      {"name": "prompt_source", "type": "text", "required": true, "agent_visible": false, "description": "Link to the prompt page (PromptHero) or the media URL (curated)."},
      {"name": "category", "type": "text", "filterable": true, "description": "Gallery or style category, e.g. anime or architecture."},
      {"name": "scraped_at", "type": "datetime", "agent_visible": false, "description": "When the row was scraped."},
      {"name": "page_url", "type": "url", "description": "Page of the prompt on its site."},
      {"name": "status", "type": "text", "filterable": true, "description": "Processing status; ERROR marks a row that failed to publish."},
      {"name": "provider", "type": "text", "required": true, "default": "prompthero", "filterable": true, "description": "Where the prompt comes from: prompthero, or the curated collection name (e.g. nanobanana, seedance)."},
      {"name": "title", "type": "text", "searchable": true, "description": "Short title of a curated prompt."},
      {"name": "prompt_text", "type": "long_text", "searchable": true, "description": "Full prompt text (curated rows only)."},
      {"name": "source", "type": "text", "description": "Repository or author a curated prompt was taken from."},
      {"name": "media_url", "type": "url", "description": "Example image or video produced by the prompt."},
      {"name": "media_type", "type": "text", "filterable": true, "description": "image or video."}
    ]
  },
  "on_this_day": {
    "title": "On this day: historical events", "entity": "historical_event", "language": "uk",
    "description": "Historical events and holidays by calendar day (no year), in Ukrainian, from daytoday.ua.",
    "suitable_for": "History and 'on this day' channels: today's events, holidays of the day.",
    "dedup_key": ["month", "day", "slug"],
    "reuse_policy": {"kind": "after_days", "days": 365},
    "roles": {"title": "title", "body": ["description", "excerpt"], "image": "image_url", "month": "month", "day": "day"},
    "fields": [
      {"name": "day", "type": "int", "required": true, "filterable": true, "description": "Day of the month (1–31) the event is remembered on."},
      {"name": "month", "type": "int", "required": true, "filterable": true, "description": "Month (1–12) the event is remembered on."},
      {"name": "title", "type": "text", "required": true, "searchable": true, "description": "Event headline."},
      {"name": "slug", "type": "text", "required": true, "agent_visible": false, "description": "URL slug of the event on the source site; part of the dedup key."},
      {"name": "excerpt", "type": "long_text", "searchable": true, "description": "One-paragraph summary."},
      {"name": "description", "type": "long_text", "description": "Full text about the event."},
      {"name": "image_url", "type": "image_url", "description": "Illustration."},
      {"name": "tags", "type": "text_list", "filterable": true, "description": "Tags from the source."}
    ]
  },
  "articles": {
    "title": "Articles", "entity": "article", "language": "uk",
    "description": "Long-form articles in Ukrainian from daytoday.ua and treatfield.com (collections, healthy lifestyle, interesting facts, movies, recipes, science, self-development, psychotherapy).",
    "suitable_for": "Channels that retell or summarise articles: lifestyle, psychology, science, movies.",
    "dedup_key": ["slug"],
    "roles": {"title": "title", "body": ["excerpt", "content"], "image": "image_url", "url": "url", "category": "category"},
    "fields": [
      {"name": "title", "type": "text", "required": true, "searchable": true, "description": "Article headline."},
      {"name": "slug", "type": "text", "required": true, "agent_visible": false, "description": "URL slug; the dedup key."},
      {"name": "url", "type": "url", "required": true, "description": "Link to the article."},
      {"name": "excerpt", "type": "long_text", "searchable": true, "description": "Lead paragraph or summary."},
      {"name": "content", "type": "long_text", "description": "Full article text (can be long)."},
      {"name": "image_url", "type": "image_url", "description": "Cover image."},
      {"name": "category", "type": "text", "filterable": true, "description": "Section of the source site."},
      {"name": "tags", "type": "text_list", "filterable": true, "description": "Tags from the source."}
    ]
  },
  "pdr_questions": {
    "title": "Driving test questions (PDR)", "entity": "quiz_question", "language": "uk",
    "description": "Official Ukrainian driving-theory exam questions (PDR tickets) with answer options, the correct answer and an explanation, from pdr-online.com.ua.",
    "suitable_for": "Driving and road-rules channels: quiz polls with the explanation.",
    "dedup_key": ["question_id"],
    "roles": {"title": "text", "body": "explanation", "image": "image_url"},
    "fields": [
      {"name": "question_id", "type": "int", "required": true, "agent_visible": false, "description": "Question id on pdr-online.com.ua; the dedup key."},
      {"name": "ticket_number", "type": "int", "required": true, "filterable": true, "description": "Exam ticket number."},
      {"name": "question_num", "type": "int", "required": true, "description": "Position of the question in its ticket."},
      {"name": "text", "type": "long_text", "required": true, "searchable": true, "description": "Question text."},
      {"name": "image_url", "type": "image_url", "description": "Road situation picture, when the question has one."},
      {"name": "answers", "type": "json", "required": true, "default": [], "description": "Answer options in order: an array of strings or of {text} objects."},
      {"name": "correct_answer_num", "type": "int", "required": true, "description": "1-based number of the correct option in answers. It is the official answer: never correct it from memory."},
      {"name": "explanation", "type": "long_text", "required": true, "default": "", "description": "Why the answer is correct, with the rule reference."}
    ]
  },
  "birthdays": {
    "title": "Birthdays of famous people", "entity": "person", "language": "uk",
    "description": "Birthdays of well-known people by calendar day, in Ukrainian, from daytoday.ua. Names of real people: personal data.",
    "suitable_for": "Biography and 'born today' channels; quote channels that pick a quote by today's birthday person.",
    "dedup_key": ["month", "day", "name"],
    "reuse_policy": {"kind": "after_days", "days": 365},
    "contains_personal_data": true,
    "roles": {"title": "name", "month": "month", "day": "day"},
    "fields": [
      {"name": "month", "type": "int", "required": true, "filterable": true, "description": "Birth month (1–12)."},
      {"name": "day", "type": "int", "required": true, "filterable": true, "description": "Birth day of the month (1–31)."},
      {"name": "year", "type": "int", "filterable": true, "description": "Birth year; empty when unknown."},
      {"name": "name", "type": "text", "required": true, "searchable": true, "description": "Full name in Ukrainian."}
    ]
  },
  "assets": {
    "title": "AI learning resources", "entity": "resource", "language": "en",
    "description": "Links to AI learning resources: OpenAI Academy courses and resources, prompt collections from Markdown repos, and MCP servers. Each row is one resource with a title, description and link; data_source tells which collection it belongs to.",
    "suitable_for": "AI and developer channels: resource of the day, tool and course recommendations.",
    "dedup_key": ["data_source", "title"],
    "roles": {"title": "title", "body": "description", "url": ["link", "source_url"], "category": "category"},
    "fields": [
      {"name": "data_source", "type": "text", "required": true, "filterable": true, "description": "Collection the row belongs to: academy-openai, academy-openai-resources, prompts-md or mcpservers."},
      {"name": "title", "type": "text", "required": true, "default": "", "searchable": true, "description": "Resource name."},
      {"name": "description", "type": "long_text", "required": true, "default": "", "searchable": true, "description": "What the resource is and why it is useful."},
      {"name": "link", "type": "url", "description": "Main link to the resource."},
      {"name": "source_url", "type": "url", "description": "Page the resource was listed on."},
      {"name": "category", "type": "text", "filterable": true, "description": "Category inside the collection."},
      {"name": "extra", "type": "json", "agent_visible": false, "description": "Collection-specific extras (e.g. GitHub stars, tags)."}
    ]
  },
  "tg_posts": {
    "title": "Ready Telegram posts", "entity": "social_post", "language": "uk",
    "description": "Pre-written Telegram posts (HTML) adapted by an LLM from self-development articles and biographies. A legacy pool: new posts are written by the editor agents.",
    "suitable_for": "Motivation and biography channels when a ready post is acceptable.",
    "dedup_key": ["content_hash"],
    "roles": {"title": "title", "body": "post", "image": "image_url", "url": "source_url"},
    "fields": [
      {"name": "source", "type": "text", "required": true, "filterable": true, "description": "Upstream pool: daytoday-self-development, samorozvytok-motivatory or birthdays-db."},
      {"name": "source_url", "type": "text", "required": true, "description": "URL of the original article; may be empty."},
      {"name": "title", "type": "text", "required": true, "searchable": true, "description": "Title of the post or the original article."},
      {"name": "image_url", "type": "image_url", "description": "Image for the post."},
      {"name": "post", "type": "long_text", "required": true, "searchable": true, "description": "Ready post text in Telegram HTML."},
      {"name": "content_hash", "type": "text", "required": true, "agent_visible": false, "description": "MD5 of post; the dedup key."},
      {"name": "author", "type": "text", "description": "Author of the original article."},
      {"name": "source_published_at", "type": "datetime", "description": "When the original article was published."},
      {"name": "tags", "type": "text_list", "filterable": true, "description": "Tags of the post."}
    ]
  },
  "jokes": {
    "title": "Jokes", "entity": "joke", "language": "uk",
    "description": "Short jokes in Ukrainian from daytoday.ua.",
    "suitable_for": "Entertainment channels: joke of the day.",
    "dedup_key": ["content_hash"],
    "roles": {"title": "title", "body": "content", "url": "url"},
    "fields": [
      {"name": "title", "type": "text", "searchable": true, "description": "Optional title."},
      {"name": "content", "type": "long_text", "required": true, "searchable": true, "description": "The joke text."},
      {"name": "content_hash", "type": "text", "required": true, "agent_visible": false, "description": "MD5 of content; the dedup key."},
      {"name": "url", "type": "url", "description": "Page the joke was collected from."}
    ]
  },
  "name_days": {
    "title": "Name days", "entity": "name_day", "language": "uk",
    "description": "Ukrainian name days: which names are celebrated on which calendar day, from daytoday.ua.",
    "suitable_for": "Calendar and 'today' channels: whose name day it is today.",
    "dedup_key": ["month", "day", "name"],
    "reuse_policy": {"kind": "after_days", "days": 365},
    "roles": {"title": "name", "month": "month", "day": "day"},
    "fields": [
      {"name": "month", "type": "int", "required": true, "filterable": true, "description": "Month (1–12)."},
      {"name": "day", "type": "int", "required": true, "filterable": true, "description": "Day of the month (1–31)."},
      {"name": "name", "type": "text", "required": true, "searchable": true, "description": "Name celebrated on this day, in Ukrainian."}
    ]
  }
  } $defs$::jsonb;
  t          text;
  d          jsonb;
  v_rel      regclass;
  v_legacy   regclass;
  v_relkind  "char";
  v_idtype   text;
  v_idkind   text;
  v_fields   jsonb;
  v_roles    jsonb;
  v_sid      uuid;
  v_prefix   text;
  v_plen     int;
  v_has_posted  boolean;
  v_has_created boolean;
  v_jsoncols text;
  v_select   text;
  v_n_legacy bigint;
  v_n_store  bigint;
  v_diff     bigint;
  c          record;
BEGIN
  FOREACH t IN ARRAY ARRAY['recipes','facts','quotes','prompts','on_this_day','articles','pdr_questions',
                           'birthdays','assets','tg_posts','jokes','name_days'] LOOP
    d := v_defs->t;
    v_rel := to_regclass('public.' || t);
    v_legacy := to_regclass('public.legacy_' || t);
    SELECT relkind INTO v_relkind FROM pg_class WHERE oid = v_rel;

    IF v_rel IS NOT NULL AND v_relkind = 'v' AND v_legacy IS NOT NULL THEN
      RAISE NOTICE '058: % already moved to the data store', t;
      CONTINUE;
    END IF;
    IF v_rel IS NULL THEN
      RAISE NOTICE '058: table % not found, nothing to move', t;
      CONTINUE;
    END IF;
    IF v_relkind <> 'r' THEN RAISE EXCEPTION '058: % is not a table (relkind %)', t, v_relkind; END IF;
    IF v_legacy IS NOT NULL THEN RAISE EXCEPTION '058: both % and legacy_% exist; resolve by hand', t, t; END IF;

    -- No writes between the copy and the rename.
    EXECUTE format('LOCK TABLE public.%I IN EXCLUSIVE MODE', t);

    SELECT format_type(atttypid, atttypmod) INTO v_idtype
      FROM pg_attribute WHERE attrelid = v_rel AND attname = 'id' AND attnum > 0 AND NOT attisdropped;
    IF v_idtype IS NULL THEN RAISE EXCEPTION '058: % has no id column', t; END IF;
    v_idkind := CASE WHEN v_idtype = 'uuid' THEN 'uuid' ELSE 'text' END;
    v_has_posted := EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = v_rel AND attname = 'posted' AND attnum > 0 AND NOT attisdropped);
    v_has_created := EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = v_rel AND attname = 'created_at' AND attnum > 0 AND NOT attisdropped);

    -- 1. Schema: curated fields + provenance fields that exist on the table + any column the list misses.
    v_fields := COALESCE(d->'fields', '[]'::jsonb);
    v_fields := v_fields || COALESCE((SELECT jsonb_agg(cf ORDER BY o) FROM jsonb_array_elements(v_common) WITH ORDINALITY x(cf, o)
                                      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_fields) f WHERE f->>'name' = cf->>'name')), '[]'::jsonb);
    SELECT COALESCE(jsonb_agg(f ORDER BY o), '[]'::jsonb) INTO v_fields
      FROM jsonb_array_elements(v_fields) WITH ORDINALITY x(f, o)
     WHERE EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = v_rel AND a.attname = f->>'name' AND a.attnum > 0 AND NOT a.attisdropped);
    v_fields := v_fields || COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'name', a.attname,
               'type', CASE
                         WHEN t2.typname IN ('int2','int4','int8') THEN 'int'
                         WHEN t2.typname IN ('numeric','float4','float8') THEN 'number'
                         WHEN t2.typname = 'bool' THEN 'bool'
                         WHEN t2.typname = 'date' THEN 'date'
                         WHEN t2.typname IN ('timestamp','timestamptz') THEN 'datetime'
                         WHEN t2.typname IN ('json','jsonb') THEN 'json'
                         WHEN t2.typname = '_text' OR t2.typname = '_varchar' THEN 'text_list'
                         ELSE 'text' END,
               'required', a.attnotnull,
               'agent_visible', true,
               'description', format('Column %s (%s) of the former %s table; not described yet.', a.attname, format_type(a.atttypid, a.atttypmod), t))
             ORDER BY a.attnum)
        FROM pg_attribute a JOIN pg_type t2 ON t2.oid = a.atttypid
       WHERE a.attrelid = v_rel AND a.attnum > 0 AND NOT a.attisdropped
         AND a.attname NOT IN ('posted', 'created_at')
         AND NOT (a.attname = 'id' AND v_idkind = 'uuid')
         AND a.attname ~ '^[a-z][a-z0-9_]{0,62}$'
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_fields) f WHERE f->>'name' = a.attname)), '[]'::jsonb);
    -- Defaults for every field: agent_visible / searchable / filterable default to visible, not searchable/filterable.
    SELECT jsonb_agg(jsonb_build_object('agent_visible', true, 'searchable', false, 'filterable', false, 'required', false) || f ORDER BY o)
      INTO v_fields FROM jsonb_array_elements(v_fields) WITH ORDINALITY x(f, o);
    v_roles := COALESCE(d->'roles', '{}'::jsonb);
    IF v_fields @> '[{"name": "source_name"}]' THEN v_roles := v_roles || '{"source_name": "source_name"}'; END IF;
    IF v_fields @> '[{"name": "source_url"}]'  THEN v_roles := v_roles || '{"source_url": "source_url"}'; END IF;
    IF v_fields @> '[{"name": "license"}]'     THEN v_roles := v_roles || '{"license": "license"}'; END IF;

    INSERT INTO data_schemas (key, title, description, entity, fields, roles, dedup_key, language, default_license,
                              reuse_policy, suitable_for, contains_personal_data, legacy, status, created_by)
    VALUES (t, COALESCE(d->>'title', t), COALESCE(d->>'description', ''), COALESCE(d->>'entity', 'item'), v_fields, v_roles,
            ARRAY(SELECT jsonb_array_elements_text(COALESCE(d->'dedup_key', '["id"]'::jsonb))),
            d->>'language', 'unknown', COALESCE(d->'reuse_policy', '{"kind": "never"}'::jsonb),
            COALESCE(d->>'suitable_for', ''), COALESCE((d->>'contains_personal_data')::boolean, false),
            jsonb_strip_nulls(jsonb_build_object('table', t, 'id', v_idkind, 'id_field', CASE WHEN v_idkind = 'text' THEN 'id' END)),
            'active', 'migration:058')
    ON CONFLICT (key) DO NOTHING;
    SELECT id INTO v_sid FROM data_schemas WHERE key = t;
    IF EXISTS (SELECT 1 FROM data_items WHERE schema_id = v_sid) THEN
      RAISE EXCEPTION '058: data schema % already has rows; refusing to copy % twice', t, t;
    END IF;

    -- 2. Copy. data = the row without id (uuid tables), posted and created_at; SQL NULLs dropped, but a
    --    jsonb column holding JSON null keeps it. Rare case-only dedup collisions get '#<old id>'.
    v_prefix := 'library://' || t || '/';
    v_plen := length(v_prefix);
    SELECT string_agg(format(' || CASE WHEN x.%1$I IS NOT NULL THEN jsonb_build_object(%1$L, x.%1$I) ELSE ''{}''::jsonb END', a.attname), '')
      INTO v_jsoncols
      FROM pg_attribute a WHERE a.attrelid = v_rel AND a.attnum > 0 AND NOT a.attisdropped
       AND a.atttypid = 'jsonb'::regtype AND a.attname <> 'posted';
    EXECUTE format($sql$
      INSERT INTO data_items (schema_id, schema_version, external_key, data, legacy_ref, posted, created_at, updated_at, status)
      SELECT %1$L::uuid, 1,
             CASE WHEN z.rn = 1 AND z.k IS NOT NULL THEN z.k ELSE COALESCE(z.k, '') || '#' || z.lid END,
             z.d, %2$L || z.lid, z.p, z.c, z.c, 'active'
        FROM (SELECT s.*, data_external_key(%3$L::text[], s.d) AS k,
                     row_number() OVER (PARTITION BY data_external_key(%3$L::text[], s.d) ORDER BY s.c, s.lid) AS rn
                FROM (SELECT data_strip_top_nulls(to_jsonb(x) - 'posted' - 'created_at' %4$s) %5$s AS d,
                             x.id::text AS lid, %6$s AS p, %7$s AS c
                        FROM public.%8$I x) s) z
    $sql$,
      v_sid, v_prefix, (SELECT dedup_key FROM data_schemas WHERE id = v_sid),
      CASE WHEN v_idkind = 'uuid' THEN '- ''id''' ELSE '' END,
      COALESCE(v_jsoncols, ''),
      CASE WHEN v_has_posted THEN 'COALESCE(x.posted, ''{}''::jsonb)' ELSE '''{}''::jsonb' END,
      CASE WHEN v_has_created THEN 'COALESCE(x.created_at, now())' ELSE 'now()' END,
      t);

    -- 3. Parity of counts, then rename and freeze the legacy table.
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO v_n_legacy;
    SELECT count(*) INTO v_n_store FROM data_items WHERE schema_id = v_sid;
    IF v_n_legacy <> v_n_store THEN
      RAISE EXCEPTION '058 parity: % has % rows but data_items got %', t, v_n_legacy, v_n_store;
    END IF;
    EXECUTE format('ALTER TABLE public.%I RENAME TO %I', t, 'legacy_' || t);
    EXECUTE format('CREATE TRIGGER legacy_readonly BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I
                    FOR EACH STATEMENT EXECUTE FUNCTION data_legacy_readonly()', 'legacy_' || t);

    -- 4. Compatibility view: same columns, order and types; ids from legacy_ref.
    SELECT string_agg(
             CASE
               WHEN a.attname = 'id' THEN format('substr(d.legacy_ref, %s)::%s AS id', v_plen + 1, CASE WHEN v_idkind = 'uuid' THEN 'uuid' ELSE 'text' END)
               WHEN a.attname = 'posted' THEN format('d.posted::%s AS posted', format_type(a.atttypid, a.atttypmod))
               WHEN a.attname = 'created_at' THEN format('d.created_at::%s AS created_at', format_type(a.atttypid, a.atttypmod))
               WHEN a.atttypid = 'jsonb'::regtype THEN format('(d.data -> %L) AS %I', a.attname, a.attname)
               WHEN a.atttypid = 'json'::regtype THEN format('(d.data -> %L)::json AS %I', a.attname, a.attname)
               WHEN t2.typcategory = 'A' THEN format('CASE WHEN d.data ? %1$L THEN ARRAY(SELECT jsonb_array_elements_text(d.data -> %1$L))::%2$s END AS %3$I',
                                                     a.attname, format_type(a.atttypid, a.atttypmod), a.attname)
               ELSE format('(d.data ->> %L)::%s AS %I', a.attname, format_type(a.atttypid, a.atttypmod), a.attname)
             END, ', ' ORDER BY a.attnum)
      INTO v_select
      FROM pg_attribute a JOIN pg_type t2 ON t2.oid = a.atttypid
     WHERE a.attrelid = to_regclass('public.legacy_' || t) AND a.attnum > 0 AND NOT a.attisdropped;
    EXECUTE format('CREATE VIEW public.%I AS SELECT %s FROM data_items d WHERE d.schema_id = %L::uuid AND d.status = ''active''',
                   t, v_select, v_sid);
    EXECUTE format('COMMENT ON VIEW public.%I IS %L', t,
                   format('Compatibility view over data_items (data schema %s, migration 058). Writes go through INSTEAD OF triggers; the old table is legacy_%s.', t, t));
    FOR c IN SELECT a.attname, pg_get_expr(ad.adbin, ad.adrelid) AS def
               FROM pg_attribute a JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
              WHERE a.attrelid = to_regclass('public.legacy_' || t) AND a.attnum > 0 AND NOT a.attisdropped LOOP
      EXECUTE format('ALTER VIEW public.%I ALTER COLUMN %I SET DEFAULT %s', t, c.attname, c.def);
    END LOOP;
    EXECUTE format('CREATE TRIGGER data_write INSTEAD OF INSERT OR UPDATE OR DELETE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION data_legacy_view_write(%L, %L)', t, t, v_idkind);
    -- `WHERE id = $1` through the view uses this index.
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON data_items ((substr(legacy_ref, %s)::%s)) WHERE schema_id = %L::uuid',
                   'idx_data_items_legacy_' || t, v_plen + 1, CASE WHEN v_idkind = 'uuid' THEN 'uuid' ELSE 'text' END, v_sid);

    -- 5. Every legacy row must equal its view row, column by column.
    EXECUTE format('SELECT count(*) FROM (SELECT * FROM public.%I EXCEPT ALL SELECT * FROM public.%I) z', 'legacy_' || t, t) INTO v_diff;
    IF v_diff <> 0 THEN
      RAISE EXCEPTION '058 parity: % rows of % differ between legacy_% and the compatibility view', v_diff, t, t;
    END IF;

    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
        EXECUTE format('GRANT SELECT ON public.%I TO editor_ro', t);
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE '058: editor_ro grant on % skipped (insufficient privilege)', t;
    END;
    PERFORM data_schema_stats_refresh(v_sid);
    RAISE NOTICE '058: moved % (% rows)', t, v_n_store;
  END LOOP;
END $move$;

-- ─── Read access for agent SQL (editor_ro, migration 042) ────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    GRANT SELECT ON data_items, data_schemas, data_schema_stats TO editor_ro;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'editor_ro grants skipped (insufficient privilege)';
END $$;

INSERT INTO schema_migrations (version) VALUES ('058_data_store')
  ON CONFLICT (version) DO NOTHING;
