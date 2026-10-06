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
