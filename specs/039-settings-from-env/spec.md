# 039: Settings from env — everything but infrastructure is edited on the dashboard

**Status:** DONE (built 2026-10-16) · **Priority:** P1 · **Linear:** AI0-120 (T1–T5: AI0-121…125) · **Depends on:** 015 (app_settings), 028 (token encryption)
· **Migration:** `078_settings_from_env.sql`

**Owner request (2026-10-15):** there is far too much in `.env`; move into the dashboard settings whatever can be moved.
Owner decisions: move everything except infrastructure, secrets included (encrypted in the DB); on the first start the service copies
the `.env` values into the DB by itself, after which the DB values win; a **Restart service** button applies the values read at boot.

## Inventory (2026-10-15)
The automation service reads ~115 env names; 6 were editable on the dashboard (`TRACKING_ENABLED`, `TELEGRAM_OWNER_ID`,
`TELEGRAM_TRACKING_SHARE_SESSION`, `STATS_POST_AGE_DAYS`, `POSTING_COOLDOWN_MIN`, `FETCH_TIMEOUT`). Almost every read goes through
`ConfigService.get`, which reads `process.env` on every call (no cache) — so values put into `process.env` are seen by every reader.

**Stays in env** (needed before the DB connects, decrypts the DB, guards sign-in, or read by Docker / nginx / Vite / processes without a
DB): `POSTGRES_*`, `DATABASE_URL`, `REDIS_URL`, `REDIS_PASSWORD`, `TOKEN_ENCRYPTION_KEY`, `NODE_ENV`, `PORT`, `SWAGGER_ENABLED`,
`DATA_IMPORT_DIR`, `JWT_SECRET`, `TRACKING_TOKEN`, `ALLOW_NO_AUTH`, `PROMO_HASH_SALT` (changing it resets dedup),
`TELEGRAM_BOT_TOKEN` and `TRACKING_ALLOWED_TG_USER_IDS` (sign-in: a bad value on the dashboard would lock the owner out),
`SCHEDULER_TZ` (legacy migration only), compose-only names (`BIND_ADDR`, `DASHBOARD_BIND_ADDR`, `DASHBOARD_PORT`, `AUTOMATION_PORT`,
`REDIS_PORT`, `*_IMAGE`), all `VITE_*` (baked into the dashboard build), the MCP server's (`EDITOR_API_URL`,
`EDITOR_MCP_ALLOW_LIVE_RUN`) and the pipeline's own variables. LLM budgets already live in `llm_budgets` (Spend → Budgets); the
`*_BUDGET_USD` names only seed it and are not in the catalog.

## FRs
- **FR-001 Catalog.** `settings/catalog.ts` is the single list of the settings the dashboard edits: env name (= the `app_settings`
  key), group, label and help (English), type (`bool`, `int`, `number`, `string`, `enum`, `list`, `url`, `cron`, `secret`), built-in
  default (the one the code uses when the variable is absent), bounds / options, and **apply** — `live` (the code reads the value on
  every use) or `restart` (read once at boot: clients, factories, `@Cron`, constructors). Groups: AI providers, Editor, Models
  (advanced: `EDITOR_MODEL_<ROLE>`, `EDITOR_ANTHROPIC_MODEL_<ROLE>`, `EDITOR_REASONING(_<ROLE>)`), Inbox agent, Publishing, Telegram,
  Integrations, Payments, Retention, Sessions. Templated families (`*_RETENTION_DAYS`, role models, platform cooldowns) are expanded to
  concrete keys. Values are validated against the catalog on write (400 `invalid_value` with the reason).
- **FR-002 Storage.** `app_settings` rows keyed by the env name. Secrets are stored encrypted (`enc:v1:…`, AES-256-GCM with
  `TOKEN_ENCRYPTION_KEY`, the same as bot / Meta / Telegraph tokens). Without `TOKEN_ENCRYPTION_KEY`, secrets are neither imported nor
  editable (they stay in env; the page says why). The `editor_ro` role keeps no access to `app_settings`. Migration 078 adds
  `app_settings_env_imports (key PK, imported_at)` — the keys whose `.env` value has already been taken in.
- **FR-003 Import at start.** Before Nest loads any module (`main.ts` imports `AppModule` only after it), the service connects with the
  `POSTGRES_*` variables and, for each catalog key not yet in `app_settings_env_imports`: if env has a non-empty value and the DB has no
  row, writes it (encrypted when secret); then records the key as imported. A key is imported once: after that `.env` edits of it are
  ignored (FR-006 shows them). Rows already in `app_settings` (the 6 old keys, platform cooldowns) count as imported. Also, for
  `my_bots`, `meta_accounts` and `telegraph_accounts` rows that have `token_env` but no `token_enc`, the env token is encrypted into
  `token_enc` (the existing `resolveToken` then prefers it).
- **FR-004 Overlay.** After the import, every catalog key with a DB row is put into `process.env` (secrets decrypted); a key imported
  but without a row (reset on the dashboard) is removed from `process.env`, so the code's built-in default applies. `ConfigModule` stops
  reading the `.env` file itself (`ignoreEnvFile: true`; `load-env.ts` already loads it into `process.env`), otherwise it would put the
  removed keys back. A DB that cannot be reached or has no migration 078 yet leaves env as is (logged). A secret that cannot be decrypted
  (key changed) keeps the env value and is flagged.
- **FR-005 Live writes.** `PUT /settings/values/:key {value}` validates, stores (encrypted when secret), records the key as imported
  and updates `process.env` at once — `live` keys take effect on the next read. `DELETE /settings/values/:key` resets to the built-in
  default (row deleted, `process.env` key removed). `POST /settings/values/:key/import-env` takes the value `.env` had at start.
  `restart` keys report **pending restart** while their value differs from the one the process booted with.
- **FR-006 State.** `GET /settings/catalog` → per key: definition, effective value (secrets: never the value — `set`, last update),
  source (`db` | `env` | `default`), `pendingRestart`, `envDiffers` (the `.env` value at start differs from the DB one and is ignored;
  for secrets only the flag), `decryptFailed`; plus `encryptionReady`, `restartSupported`, `bootedAt`. The old `GET / PATCH /settings`
  keep their shape and go through the same store.
- **FR-007 Restart.** `POST /settings/restart` → 202, then the process shuts down gracefully (`enableShutdownHooks`, hard exit after
  15 s) and Docker starts it again (`restart: unless-stopped`). Refused with 409 `restart_unsupported` under `NODE_ENV=local-development`
  (no supervisor would start it again).
- **FR-008 Page.** `/app/settings` gets a **Configuration** tab (default; the old `telegram` / `ai` / `meta` tab links open it):
  search, group chips, one card per group, one row per setting — input by type, source badge, `restart` badge, pending-restart and
  `.env differs` notes with **Use .env value**, **Reset**, secrets write-only (Replace / Clear). Every change goes through a confirm
  showing old → new (secrets: set / not set). A banner lists the settings waiting for a restart with the **Restart service** button
  (confirm; then the page waits for the service to come back). Security and Navigation tabs stay.
- **FR-009 Fixes found on the way.** `.env.example` `NODE_ENV=development` (the service refuses it) → `local-development`; the admin bot
  now sees an owner id set only on the dashboard and `FETCH_TIMEOUT` set on the dashboard reaches the Meta client (both via the
  overlay); clearing the owner id on the dashboard resets it to the default instead of storing an empty override. `.env.example` lists
  only what stays in env, plus a note that the rest is imported once and then edited on the dashboard; dead names removed
  (`AD_ORDER_CURRENCY`, `INSTAGRAM_ACCOUNT_ID`, `THREADS_USER_ID`, `FACEBOOK_PAGE_ID`, `META_APP_ID`, `META_APP_SECRET`).

## Decisions
- One overlay instead of rewriting ~115 reads to a settings getter: no reader changes, small regression surface. Values read at boot
  need the restart button rather than being made live one by one.
- Single instance (owner decision, own network): no cross-process invalidation; the MCP server and the pipeline keep their own env.
- Reset means the built-in default, not `.env` — after the import the DB is the source of truth; **Use .env value** is explicit.
- Changes are logged by key (never values).

## Verification
Unit: catalog (every key valid, defaults pass their own validation, no infra key), overlay (import once, secrets encrypted, reset
removes, decrypt failure keeps env, no DB → env kept), store (validation, live `process.env`, pending restart, env differs), restart
guard. PG: migration twice, import + overlay against a scratch DB, token_env → token_enc. Dashboard: helper tests, UI harness at 375 px
and desktop. No real data, no real channels, no paid calls.
