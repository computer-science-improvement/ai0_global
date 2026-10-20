# Release checklist — wave 2 (specs 033–058, migrations 062–091)

Branch `feat/editor-agent` → `develop`. **Every push to `develop` deploys dev-stage** (`.github/workflows/deploy-develop.yml`:
build images → `database/migrate.sh` → new containers). Prod is a separate step (tag on `main`, `prod-release.md`); `main` is
still at 2026-05-16 (29e1d076), so the prod release carries everything since then — do it only after the stage week below.

Already on `develop` (and so on stage once the workflow ran): migrations **062–068, 070–082, 084–089** (069 unused).
Coming with the next push: **083** (post_requires repair, ported from d091de8d), **090** (spec 057), **091** (spec 058).

## Before a push to develop
- [ ] Stage DB backup (`backup-restore.md`). 083 rewrites `data_items` rows (with an undo table) — the backup is the fallback.
- [ ] CI green on `feat/editor-agent` (Node 20 + `nest build`).
- [ ] GitHub Actions → *Deploy develop -> dev-stage*: the last run is green (a red run means stage is on an older image while
      the DB may already be migrated — check `SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 5;`).

## Right after the deploy (15 min)
- [ ] Migration log: every file applied once; `SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 10;`
      shows 091 … 083 … 080.
- [ ] 083: run `database/reports/unpostable-rows.sql`, read the repair counts; the undo table is the way back if something looks wrong.
- [ ] Settings → Configuration: new rows exist (`SETUP_PROPOSAL_TTL_DAYS` 14, the `AUDITOR_*` five, `EDITOR_LADDER_EXTRA_STEPS` 1).
      Values imported from `.env` once; the DB wins after that (spec 039). `TOKEN_ENCRYPTION_KEY` must never change.
- [ ] `/app/health`: the keeper, reminders, source health and the Owner bot section are green; Owner bot → **Send a test card**.
- [ ] `/app/map`: territories, platform sections, bots/MTProto/Telegraph row; click a road → Break link works and the line goes;
      a building → Links → Link resources… (spec 058).
- [ ] An agent page → **Loadout** tab (054): tools, usage, suggestions render.
- [ ] `/app/setup`: open a proposal; an old untouched one closes as **Expired** within an hour of the deploy (057) — one
      owner Inbox note lists the channels.
- [ ] `/app/artifacts` and the chat `/setup`, `/steer` chips open.
- [ ] `/audit` (055): Run again works with no model key (code checks only); with the key, one bounded LLM pass.

## Owner actions still open
- [ ] Spec 040 data: deactivate rules #10/#14/#15, re-add the 8-point rule via the card; discard the Loko v7 / nova v2 drafts;
      apply @ai0's `fix_config_conflicts` card.
- [ ] Spec 046: remove the Opus agent models of @manager and the weekly reviewers; clear the Anthropic critic model; keep the
      Anthropic default empty.
- [ ] Spec 002: apply migration 045 if it is still pending (`SELECT 1 FROM schema_migrations WHERE version LIKE '045%';`).

## Measurements (after 2 full days on stage)
- [ ] Token economy (053): `llm-cost-report.sh 2` (scp/ssh commands in `specs/053-token-economy/runbook.md` — use the absolute path) →
      fill the Measurements table in `specs/053-token-economy/tasks.md`; target ≤ $3/day total. Then decide on
      `EDITOR_ANTHROPIC_TOOLS_CACHE_TTL=1h`.
- [ ] First weekly @sysadmin audit (055): the report appears in `/app/artifacts` and as an Inbox note; apply or dismiss each
      finding; a missed week → `agent-platform.md` §16 (how to check a missed week).

## Prod (develop → main)
- [ ] One clean week on stage with the items above ticked.
- [ ] Fresh prod backup; check the prod DB locale (`SHOW lc_ctype;`) and the pitfalls list in `release-2026-10-agent-wave.md`
      (loopback ports, Redis `dump.rdb`, image exports).
- [ ] Merge `develop` → `main`, tag `vX.Y.Z` (`prod-release.md`). The prod migration run is long: 055–091 in one go,
      including 058 (data store move) and 060 (ledger backfill) — low-traffic window.
- [ ] Same "Right after" list on prod; every resource starts as it was (no channel switches to live by itself).
