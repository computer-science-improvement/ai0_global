# 032: Unified data store: one items table, editable schemas, CSV/JSON import without migrations

**Status:** SPEC · **Depends on:** — (lands before 023 T1/T2) · **Extends:** 023 FR-008 (`library_catalog`) and FR-010
(ledger refs) · **Migration:** `058_data_store.sql` (the last migration any content dataset needs)

**Owner decision (2026-10-06, chat):** «я хочу у майбутньому мати можливість додавати данні із csv або json, я не хочу
потім міграції накатувати, тому потрібне рішення яке буде уніфікувати формати, колонки та ентеті, і окрема таблиця із
схемами, кожен рядок данних має звязок зі своєю схемою». Earlier in the same thread: the schema is an editable
description of every field, so the agent reads only schemas, decides whether the data fits, and only then fetches rows.

## Why
- **Twelve content tables, each with its own columns.** They are `recipes`, `facts`, `quotes`, `prompts`,
  `on_this_day`, `articles`, `pdr_questions`, `birthdays`, `assets`, `tg_posts`, `jokes` and `name_days`, all in
  `database/init.sql`.
- **A new dataset costs a migration and code.** It needs a migration, a pipeline loader and an entry in
  `editor/tools/library-tables.ts`, or agents never see it.
- **Agents fetch blind.** They know only table names: `search_library` returns 8 random rows of up to 800 characters,
  and `sql_readonly` lists bare table names. The agent pulls rows first and judges relevance afterwards.

This spec stores every content dataset in one table, `data_items`. Each row points to its schema in `data_schemas`,
which describes the dataset and every field in plain words. A new dataset is a schema row plus an import from CSV or
JSON, with no migration. Agents read the schemas first and fetch only the fields they need.

## Current state (as-is)
- **Content tables (init.sql).** Each table has its own columns plus a `posted` JSONB dedup marker; migration 043
  added `license` and `source_name` to all of them.
- **Readers.**
  - Strategy repositories under `strategies/*/*.repository.ts`.
  - `config/strategy-preview.service.ts`.
  - `editor/post/quiz-ground-truth.ts` (`pdr_questions`).
  - Editor tools: `search_library` through `LIBRARY_TABLES`, and `sql_readonly`.
- **Writers.**
  - Pipeline: `apps/pipeline/src/lib/loader.js` (`loadRows(table, rows, {columns, conflictTarget, updateColumns})`),
    with loaders in `src/loaders/*.js` and `src/tg/adapt-biographies.js`.
  - Strategies write the `posted` markers (`UPDATE <table> SET posted = posted || …`) and some derived fields (recipe
    translations, `telegraph_url`).
- **Out of scope:** `posted_news` (a URL dedup ledger, replaced by 023 FR-010) and all operational tables (editor,
  agents, stats, tracking, payments, auth). Those are platform state, not content data.

## Functional requirements
| ID | Requirement |
|---|---|
| FR-001 | **`data_schemas`** (`058_data_store.sql`). <br>• Columns: `id uuid pk`, `key text unique` (slug, e.g. `recipes`, `pdr_questions`), `title`, `description` (what the data is, for whom, how to use it), `entity` (free-text kind: `recipe`, `quiz_question`, `historical_event`, `person`, `quote`, `prompt`, `article`, …), `version int`, `fields jsonb` (FR-002), `roles jsonb` (FR-003), `dedup_key text[]` (field names that build `external_key`), `language text`, `default_license text`, `reuse_policy jsonb` (`{kind: never}` or `{kind: after_days, days}`), `suitable_for text` (topics and resources it fits), `status` (`draft`, `active`, `archived`), `created_by`, `created_at`, `updated_at`. <br>• `data_schema_versions(schema_id, version, fields, roles, changed_by, reason, created_at)` keeps every structural version. |
| FR-002 | **Field definitions.** Each element of `fields` is `{name, type, description, required, agent_visible, searchable, filterable, example?, enum?, deprecated?}`. <br>• `type` is one of `text`, `long_text`, `int`, `number`, `bool`, `date`, `datetime`, `month_day` (`MM-DD`), `url`, `image_url`, `enum`, `text_list`, `json`. <br>• Names are snake_case and are never removed or renamed in place. Old fields are marked `deprecated`, so every stored row stays valid. <br>• **Description-only edits** (descriptions, `suitable_for`, `agent_visible`, `searchable`, `filterable`) do not bump the version. **Structural edits** (a new field, a deprecation, a type change made as a new field, a role change) bump `version` and write `data_schema_versions`. <br>• A new `required` field must have a default, or it is required only for rows of the new version. |
| FR-003 | **Roles (the common shape).** `roles` maps universal roles to field names: `title`, `body`, `image`, `url`, `category`, `date`, `month_day`, `lang`, `source_name`, `source_url`, `license`. <br>On every write the store fills the matching envelope columns of `data_items` from these roles. Every dataset can then be listed, filtered, searched and previewed the same way, whatever its own fields are. |
| FR-004 | **`data_items`.** <br>• Columns: `id bigserial pk`, `schema_id uuid not null references data_schemas`, `schema_version int not null`, `external_key text not null`, `data jsonb not null` (all fields), plus envelope columns `title`, `body`, `image_url`, `url`, `category`, `lang`, `event_date date`, `event_month smallint`, `event_day smallint`, `license`, `source_name`, `source_url`. Also `status` (`active`, `hidden`), `legacy_ref text unique null` (FR-008), `posted jsonb not null default '{}'` (transition only, FR-008), `import_id uuid null`, `search tsvector` (generated from title and body), `created_at`, `updated_at`. <br>• `unique (schema_id, external_key)`. <br>• Indexes: `(schema_id, status)`, `(schema_id, category)`, `(schema_id, event_month, event_day)`, GIN on `search`, GIN `jsonb_path_ops` on `data`. <br>• `GRANT SELECT` on `data_items`, `data_schemas` and `data_schema_stats` to `editor_ro`. |
| FR-005 | **One write path.** <br>• A SQL function `data_items_upsert(p_schema_key text, p_rows jsonb, p_import_id uuid default null, p_update_fields text[] default null)` is the only writer. It does the following: <br>  – resolves the schema; <br>  – builds `external_key` from `dedup_key` (values joined with a separator and lower-cased; an explicit `_external_key` in a row wins); <br>  – checks required fields and basic types; <br>  – fills the envelope from `roles`; <br>  – inserts, or on conflict merges only `p_update_fields`, or every field when null; <br>  – returns `{inserted, updated, skipped, invalid: [{row, field, error}]}`. <br>• TypeScript `DataStore` (automation) and JS `loadData(schemaKey, rows, opts)` (pipeline `lib/loader.js`) are thin wrappers around this function, so there is no duplicated logic. <br>• The automation side also validates strictly with a zod schema compiled from `fields` before calling the function (imports and API). |
| FR-006 | **Import from CSV or JSON** (`/api/data/imports`, `TrackingAuthGuard`). <br>• Upload a `.csv` (UTF-8; comma, semicolon or tab detected), `.json` (array of objects) or `.jsonl`; at most 20 MB and 200k rows, parsed as a stream. <br>• **Into an existing schema:** columns are matched to fields by normalised name, and the owner adjusts the mapping. Unmapped columns are ignored or kept under `data._extra`. <br>• **As a new schema:** types are inferred deterministically from a sample of 500 rows (url, image by extension, int, number, bool, date, month_day, enum when there are ≤ 20 distinct values, long_text when over 300 characters). The owner sets names, roles, `dedup_key` and descriptions. `@ai0` may draft the descriptions as a pending action, with the owner's Apply. <br>• **Dry run first:** valid, invalid, new and updated counts, the first 100 errors and 10 preview rows rendered through the roles. Then the owner commits. <br>• **Audit:** `data_imports(id, schema_id, source csv/json/jsonl/pipeline/api, filename, mapping jsonb, rows_total, inserted, updated, skipped, invalid, errors jsonb, status, created_by, created_at, finished_at)`. <br>• **Undo an import:** deletes the rows it inserted that are not yet in the content ledger (023), hides the used ones, and restores updated rows from the snapshot the import keeps. <br>• `POST /api/data/:schema/rows` (JSON array, ≤ 5k rows) does the same for scripts. |
| FR-007 | **Dashboard `/app/data`** (sidebar: Content → Data). <br>• **Datasets list:** title, entity, rows, unposted network-wide, last import, status. <br>• **Schema editor:** dataset texts, a field table (description, type, flags, example, deprecate, add field) and the roles mapping. A structural edit shows its version bump and how many rows are affected before saving. <br>• **Items browser:** filters built from `filterable` fields, full-text search, a card preview through the roles, and hide/unhide. <br>• **Import wizard** (FR-006) and the import history with undo. |
| FR-008 | **One-time move of the 12 content tables** (inside 058). <br>• Seed one schema per table from its real columns, with descriptions taken from `library-tables.ts` and the column meaning; roles follow today's `LIBRARY_TABLES` mapping; `dedup_key` follows each table's current unique key, or `id` when there is none. <br>• Copy every row into `data_items` with `legacy_ref = 'library://<table>/<id>'`, carrying `posted`, `license` and `source_name`. <br>• Rename each table to `legacy_<name>` (kept read-only for 30 days, then dropped by an owner-approved migration). <br>• Create a **compatibility view** with the old name and old columns (projected from `data` and the envelope), so every reader keeps working unchanged. Old ids stay stable through `legacy_ref`. <br>• `INSTEAD OF INSERT/UPDATE` triggers on each view route writes (pipeline upserts, `posted` markers, translations, `telegraph_url`) into `data_items`. <br>• **Parity check in the migration:** per-table row counts must match, otherwise the whole migration rolls back. |
| FR-009 | **Writers move to the store.** <br>• Pipeline loaders call `loadData(schemaKey, …)` instead of `loadRows(table, …)`, and `load-config.json` maps sources to schema keys. <br>• Strategy repositories read through the compatibility views until 023/009 retire them. Their `posted` writes go through the triggers until 023 FR-010 moves dedup to the content ledger; after that `data_items.posted` is dropped. <br>• No new code may reference a content table by name; a lint test greps for it. |
| FR-010 | **Agents read schemas first.** <br>• **`library_catalog`** (023 FR-008) is built from `data_schemas`: dataset title, description, entity, `suitable_for`, the agent-visible fields with their descriptions, and stats (rows, unposted on this resource and on the network from the ledger, today-items for `month_day`/`date` roles, top categories, fill rate per field). Stats come from `data_schema_stats`, recomputed nightly and after each import. <br>• **New tool `query_data`:** `{schema, fields[], filters: [{field, op: eq, in, ilike, gte, lte, between, is_null, today}], unposted_on?: resource_ref, order: random, newest or oldest, limit ≤ 20}`. Fields and filters are validated against the schema (only `agent_visible`/`filterable` ones), and only the requested fields come back, each with `ref = data://<schema_key>/<id>`. <br>• `search_library` stays one release as a wrapper over `query_data`. <br>• `sql_readonly` lists `data_items` and `data_schemas` instead of the old tables. <br>• Agents never change a schema's structure. They may propose a description edit (pending action `edit_data_schema`: field, old and new text, evidence), which the owner applies. <br>• The `content-sources` skill (023) says: read the catalog, choose by description and stats, fetch only the needed fields. |
| FR-011 | **Refs and dedup.** <br>• The canonical ref is `data://<schema_key>/<id>`. The 023 ledger accepts `library://<table>/<id>` as an alias resolved through `legacy_ref`, so history keeps counting. <br>• The reuse policy (`never` or `after_days`) comes from the schema, not from code (023 FR-010's per-table rules move into `reuse_policy`). |

## Corner cases
- **A CSV with a BOM, quoted newlines or a different delimiter** is handled by the parser. A broken row becomes an
  invalid row in the report and never aborts the import.
- **The same `external_key` twice in one file:** the last row wins, and the report counts duplicates.
- **A schema edit while an import runs:** the import pins `schema_version` at start; rows are validated against that
  version.
- **Very large `long_text`:** stored in full, and `query_data` truncates to 2000 characters unless the field is
  requested explicitly with `full: true`.
- **An image URL is dead.** Not checked at import (too slow). A nightly sampler marks the image fill rate as "broken
  links N %" in the stats.
- **Personal data** (e.g. `birthdays` of real people): the schema has a `contains_personal_data` flag that the catalog
  shows to agents. No new rule beyond today's.
- **Rollback of the move:** the legacy tables stay for 30 days; a script recreates the old tables from them if needed.

## Non-goals
- Moving operational tables (editor, agents, stats, tracking, payments, auth) into the store.
- Vector embeddings or semantic search (a later spec can add an `embedding` column without changing this model).
- Importing from Google Sheets, URLs or APIs on a schedule (later; the API endpoint already allows scripts).
- Agents creating schemas or importing data by themselves.

## Success criteria
- After 058, every existing reader and test works unchanged through the compatibility views. Row counts match per
  table; 20 sampled rows per table are equal field by field.
- A new dataset (a test CSV with 1 000 rows and 6 columns) is created, described and imported from the dashboard with
  no migration and no code change. An agent sees it in `library_catalog` and fetches it with `query_data`.
- Undoing that import removes its unused rows and restores the updated ones.
- **Agent token use:** on the `executor-picks-dataset` eval the executor reads the catalog and calls `query_data`
  with ≤ 5 fields, and the tokens spent on library data are ≥ 50 % lower than with today's `search_library` on the
  same case.
- Tests:
  - `data_items_upsert` (insert, merge, invalid rows, dedup key);
  - the zod compiler per type;
  - type inference;
  - CSV/JSON parsing edge cases;
  - view triggers for every legacy write path;
  - the grep lint for content table names.

## Open questions for the owner
1. **CSV parser:** add `csv-parse` (well maintained, streaming, about 30 KB) to automation? Default: yes.
2. **Legacy tables:** keep 30 days after the move, then drop with your approval? Default: yes.
3. **Who may import:** only the owner in the dashboard plus the API with the same login. Default: yes. Agents only
   suggest.

## Task breakdown
### T1: Store schema, write path and validation
**Scope:** `058_data_store.sql`: `data_schemas`, `data_schema_versions`, `data_items`, `data_imports`,
`data_schema_stats`, `data_items_upsert()` and grants (FR-001…FR-005); `DataStore` (TS), the zod compiler from
`fields`, schema versioning rules.
**Acceptance:** PG tests for upsert, merge, invalid rows and the dedup key; zod compiler tests per type; a
description-only edit keeps the version and a structural edit bumps it.
**Size:** M · **Depends on:** —

### T2: Move the 12 content tables behind compatibility views
**Scope:** seeded schemas with descriptions; the copy with `legacy_ref`; the rename to `legacy_*`; compatibility views
with `INSTEAD OF` triggers; the parity check that rolls back on mismatch (FR-008).
**Acceptance:** the full automation suite stays green on a scratch PG with production-shaped data; per-table counts
and 20-row samples match; every legacy write path (pipeline upsert, `posted`, translation, `telegraph_url`) goes
through a trigger in a test.
**Size:** L · **Depends on:** T1

### T3: Move writers to the store
**Scope:** pipeline `loadData()` and loaders on schema keys; automation writers on `DataStore`; the grep lint for
content table names (FR-009).
**Acceptance:** the pipeline loader tests are green against the store; the lint fails on a new reference to a content
table.
**Size:** M · **Depends on:** T2

### T4: CSV / JSON import API with dry run and undo
**Scope:** streaming parsers (CSV, JSON, JSONL), mapping, type inference, dry run, commit, `data_imports` audit, undo,
`POST /api/data/:schema/rows` (FR-006).
**Acceptance:** edge-case parsing tests (BOM, quotes, delimiters, broken rows); inference tests; undo restores
updated rows and deletes unused new ones.
**Size:** L · **Depends on:** T1

### T5: `/app/data` dashboard
**Scope:** datasets list, schema editor with version preview, items browser, import wizard and history (FR-007).
**Acceptance:** browser check in the dev preview at desktop and 375 px: create a dataset from a CSV, edit a
description, add a field, import, undo.
**Size:** L · **Depends on:** T4

### T6: Agents work from schemas
**Scope:** `library_catalog` from schemas and nightly `data_schema_stats`; the `query_data` tool; `search_library` as a
wrapper; `sql_readonly` description; the `edit_data_schema` suggestion card; skill text; refs and reuse policy
(FR-010, FR-011).
**Acceptance:** tool validation tests (non-visible field refused, filter on a non-filterable field refused); the
`executor-picks-dataset` eval with the token comparison.
**Size:** M · **Depends on:** T2

## Implementation notes (T1–T4, 2026-10-06)
Built on `feat/editor-agent` in commits `38f5d35` (T1), `a2555a3` (T2), `5056ba0` (T3) and `9bae25d` (T4). T5 and T6 are
not built; `library-tables.ts` and `search_library` are unchanged and read through the compatibility views.

Deviations from the text above:
- **Extra columns.** `data_schemas` has `legacy` (`{table, id, id_field?}` for the 12 moved tables) and
  `contains_personal_data`. `data_imports` also has `schema_version`, `options`, `duplicates`, `preview`, `undo_report`
  and `undone_at`, and two more statuses: `dry_run` and `expired`. Updated rows are snapshotted in
  `data_import_snapshots`.
- **Roles.** A role can be a list of fields (the first non-blank value wins, e.g. recipes `title: [title_uk, title]`).
  There are also `month` and `day` roles for datasets that keep the month and the day in two int fields.
- **No targeted `ON CONFLICT` on the views.** Postgres cannot infer a unique index on a view. A plain `INSERT` (or
  `ON CONFLICT DO NOTHING` with no target) through a view inserts a new row and skips an existing dedup key. The
  pipeline now uses `loadData()`.
- **The move copies rows with set-based SQL.** It does not call `data_items_upsert()` row by row. Parity compares
  every row, legacy table against view (`EXCEPT ALL`), not just 20 samples. The test also samples 20 rows per table.
- **Posted markers bypass `data_items_upsert()`.** The view trigger writes `posted` (not a data field) straight to
  `data_items.posted` as a delta, so two writers never lose a marker. Data columns go through `data_items_upsert()`.
- **Dedup key collisions.** Legacy keys that collide only after lower-casing get `#<old id>` appended, so no row is
  lost. `lower()` follows the database collation.
- **Changing a dedup field** through a view `UPDATE` keeps the row's original `external_key`.
- **"Used" (undo).** Until the 023 ledger exists, a row counts as used when `posted` has a non-`error:` key, or when
  `published_posts.source_url` is `data://<key>/<id>` or its legacy ref.
- **Pinned schema version.** Rows are validated against the version pinned at the dry run (zod). The SQL write
  path still applies the current version's basic checks.
- **Inference details.** Enum inference also needs values to repeat (distinct ≤ half of the values) and to be
  ≤ 64 characters. In JSON imports an empty string is a value; in CSV an empty cell counts as missing.
- **`init.sql`** skips a content table once it is a view, so re-running it after 058 stays safe.
- **Rows endpoint body limit.** `POST /api/data/:schema/rows` gets its own 10 MB JSON parser, mounted in
  `main.ts` before Nest's default 100 KB parser.
- **Open question 1.** No `csv-parse`. The parser is our own (no new dependencies).
- **Pipeline audit.** Every pipeline `loadData()` call is audited in `data_imports` (source `pipeline`).
