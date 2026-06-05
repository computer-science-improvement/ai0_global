---
name: monorepo-apps-pipeline
description: >-
  Coding conventions for ai0_global apps/pipeline (Node ESM parsers/loaders, src/data lifecycle, tools). Load when editing anything under apps/pipeline.
---

# Coding guide: `apps/pipeline`

## Layout

- **Runtime code**: `apps/pipeline/src/` only (strict layout).
- **Data**: `apps/pipeline/src/data/` — `raw/`, `normalized/`, `generated/`, `publish-ready/`.
- **Config / docs / one-off tools**: `apps/pipeline/src/config/`, `src/docs/`, `src/tools/` (including `src/tools/additional-data/scripts/` for TS scrapers).
- **DB bootstrap from code**: `src/init-db.js` reads repo-root `database/init.sql` (do not move SQL into `src/`).

## Parsers

- Location: `src/parsers/*.js` (ESM).
- Export `export default async function run()`.
- **Auto-run**: `src/run-parsers.js` loads every `*.js` except `_*.js` and `example-parser.js`.
- **CLI guard**: at bottom, run only when `import.meta.url === pathToFileURL(process.argv[1]).href` (avoid double execution when imported).
- **Output**: use `src/lib/json.js` — `saveRawJson`, `saveNormalizedJson`, `savePublishReadyJson`, etc. Pick lifecycle stage that matches downstream loaders.
- **HTTP**: prefer `src/lib/fetch.js` + cheerio / `src/lib/scrape.js` for static HTML.

## Loaders

- Location: `src/loaders/*.js`.
- Paths: `join(__dirname, '..', 'data', '<stage>', ...)` (loaders live in `src/loaders/`, so one `..` reaches `src/`).
- Use `pool` from `src/lib/db.js` and `loadRows` from `src/lib/loader.js`; mirror existing tables’ columns and `ON CONFLICT` targets from `database/init.sql`.

## Package scripts

- Run from repo root: `pnpm --filter pipeline run <script>`.
- Env: many scripts use `node --env-file=../../.env` (repo root `.env`).

## Scope discipline

- Do not edit `apps/automation` when the task is pipeline-only.
- If a new **table or column** is required, stop and hand off to the **database agent** with a written spec (no silent `init.sql` edits unless the user explicitly asked for schema work in the same task).
