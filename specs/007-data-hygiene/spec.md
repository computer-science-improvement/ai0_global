# 007: Data hygiene

**Status:** TODO · **Depends on:** none

## Requirements and tasks
- [x] T001 **Untrack `.pnpm-store/`** (3,094 files): `git rm -r --cached .pnpm-store` and add it to `.gitignore`. History purge (77 MB pack) is the owner's decision, using `git filter-repo`, documented only.
- [~] T002 **Raw data out of git and image:** *(partial: the `.dockerignore` part and the read-only compose mount are done. The move to object storage, the fetch script and the single canonical copy are blocked: the owner kept the files tracked and there is no object-storage access. The measured duplication and the proposed migration are in `docs/runbooks/raw-data.md`.)*
  - Move `apps/pipeline/raw-data` (~166 MB, recipes stored three times) to object storage or a release asset, with a fetch script.
  - Keep one canonical copy.
  - Add `raw-data` to the pipeline `.dockerignore`.
- [x] T003 **Retention:**
  - Turn on `RETENTION_ENABLED` by default in `.env.example`.
  - Extend coverage to `strategy_runs` (90 d), `editor_run_steps` (30 d), `editor_runs` (180 d), `tracked_posts.text` (null after 30 d), `agent_dm_threads`/`agent_opportunities` text (90 d, privacy), `candidate_channels.raw_payload` (30 d).
  - `bot_logs` stays (it is a dedup ledger until 009).
- [x] T004 **Schema bootstrap:**
  - Add `IF NOT EXISTS` to `init.sql:155`.
  - Add a CI job that builds a fresh Postgres from `init.sql` + `migrations/*` and fails on error.
  - Rename root scripts `migrate`→`db:init` to remove the confusion with `db:migrate`.
- [x] T005 **Fix the seed:** *(`recipes-epicure` got a default export, so `parse`/`sync` regenerates the gitignored `recipes.json`. It skips when raw-data is absent, and `load:recipes` warns and skips when `recipes.json` is missing, so `load:all` no longer aborts halfway.)*
  - `run-parsers.js` ignores `*.test.js`.
  - `recipes-epicure.js` gets a default export, or `load:all` drops it.
  - `load:all` includes `prompts-github` and `treatfield`.
- [x] T006 **Destructive scripts:**
  - `load:recipes:fresh` requires `ALLOW_TRUNCATE=yes` and keeps translations and `posted` (an upsert instead of TRUNCATE).
- [ ] T007 **Dead data:**
  - Drop the `tg:adapt-*` scripts (the editor replaces them).
  - Mark `tg_posts`, `jokes`, `name_days` and `articles` as editor library sources (they are granted to `editor_ro` in 003), so they become useful instead of dead.
- [ ] T008 **Licensing:**
  - Add `source_name`, `source_url`, `license` (`unknown|permitted|own|cc-by|pd`) columns to the library tables.
  - The `source-licensing` skill (004) tells the executor to write original text and attribute when `license='unknown'`.
  - Stop republishing Epicure recipes verbatim (009 handles the cutover).
- [ ] T009 **Config clutter:** delete `channels.local.full-backup.json` and `channels.local.before-discovery.json`, and mark `channels.json` as legacy in the README.
- [ ] T010 **Docs:**
  - README (real scripts, dashboard, migrations, editor).
  - Move `DESIGN.md` (Framer reference) to `docs/reference/`.
  - Update `plans/README.md` statuses, or archive it in favour of `specs/`.
