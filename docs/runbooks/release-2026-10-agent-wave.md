# Release checklist — agent wave (specs 023 T1–T3, 024 T1–T2, 027, 028, 029, 031, 032)

Branch `feat/editor-agent`. Stage first (`develop` → dev-stage, `.github/workflows/deploy-develop.yml`), then prod (tag on `main`,
`docs/runbooks/prod-release.md`). New migrations: **055–058, 060, 061**.

## Before the stage deploy
- [ ] CI on `feat/editor-agent` is green (`ci-feature.yml`).
- [ ] Backup the stage DB (`docs/runbooks/backup-restore.md`).
- [ ] Check the DB locale: `SHOW lc_ctype;` — `C` makes Cyrillic full-text search empty (not breaking, weaker agent search).
- [ ] `.env` on the box (names only; values stay on the box):
  - `DASHBOARD_URL` — link in the "posts to approve" Telegram alert.
  - Optional: `AI_DAILY_BUDGET_USD` (default 3), `EDITOR_DAILY_BUDGET_USD` (2), `EDITOR_CHANNEL_DAILY_BUDGET_USD` (0.30),
    `LLM_USAGE_RETENTION_DAYS`, `AUTH_ACCESS_TTL_MIN`, `AUTH_IDLE_TTL_DAYS`, `AUTH_ABSOLUTE_TTL_DAYS`, `AUTH_EVENTS_RETENTION_DAYS`.
  - Env values only seed the cap rows on first boot; afterwards edit caps on `/app/spend` → Budgets.
- [ ] GitHub Variable `VITE_AUTH_MODE=token` (or `VITE_TG_BOT_USERNAME`) — a production dashboard build now fails without a sign-in method (028).

## Deploy (low traffic)
- [ ] Merge `feat/editor-agent` into `develop` → the workflow runs `database/migrate.sh`, then the new images.
- [ ] Pipeline and automation go together — old pipeline loaders fail against the 058 compatibility views.
- [ ] Watch the migration log:
  - 058 moves the 12 content tables into `data_items` (~45–60k rows, est. 5–10 s; aborts and rolls back if per-table counts differ).
  - 060 backfills `content_ledger` (~310k rows / ~14 s on a synthetic set; writes to those tables wait).
  - If a migration fails the release stops before the new image starts; restore from the backup only if the DB is half-applied
    (each file is one transaction, so normally nothing to restore).

## Right after
- [ ] Everyone signs in again (old cookies show "sign in again after the security update").
- [ ] `SESSION_COOKIE=… STOP_AUTOMATION=1 bash scripts/smoke-auth-gate.sh` against the stage host.
- [ ] `/app/spend` → Prices: verify the seeded prices (Perplexity `sonar-pro`, xAI `grok-3` are estimates). Budgets tab: caps as intended.
- [ ] `/app/data`: 12 datasets listed with row counts matching the old tables.
- [ ] Groups now `independent` with a live orchestrator and a playbook stop auto-duplicating from the next plan day — confirm that is intended;
      `orchestrated` groups with a shadow/off orchestrator auto-duplicate again (no resource goes silent).

## Live test of approval mode (owner, ~1 week)
- [ ] Connect or create a test resource → it starts in **approve**.
- [ ] The evening batch appears in **Posts to approve**; the Telegram alert arrives with a link.
- [ ] Approve, Edit and approve, Reschedule, Reject with a reason; let one post expire.
- [ ] Next day: the agent's prompt reflects your edits/reasons (agent page → Approval stats).
- [ ] Switch the resource to **Live** (dialog with 14-day stats), then back to approval in one click.
- [ ] Close 028-T5/T7 after the browser login flows work on stage (deep link → login → same page; sign out everywhere).

## Prod
- [ ] After a clean week on stage: merge to `main`, tag `vX.Y.Z` (see `prod-release.md`), same checklist on prod with a fresh backup.
- [ ] After 30 days on prod: approve the migration that drops the `legacy_*` content tables (032).
