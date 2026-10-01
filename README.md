# ai0_global

An owner-operated, ad-monetized Ukrainian media network. Telegram channels come first, with Meta
(Instagram/Facebook/Threads) and TikTok mirrors. It runs as a single instance and is not a SaaS
product. Principles and constraints are in the
[constitution](.specify/memory/constitution.md).

## Apps

| App | Stack | What it does |
|-----|-------|--------------|
| [`apps/automation`](apps/automation) | NestJS 10, `pg` (raw SQL), BullMQ/Redis | The service. It runs the **editor agent** (planner/executor/reviewer per channel), the legacy cron strategies, publishers (Telegram, Meta, TikTok, Telegraph), channel tracking/stats (MTProto), discovery, the agent DM inbox, alerts, and nightly retention. It applies DB migrations on boot. |
| [`apps/dashboard`](apps/dashboard) | React, TanStack Router, Vite, Tailwind | The owner dashboard: a public landing at `/` and the guarded app at `/app/*`. It talks to automation over `/api`. See [its README](apps/dashboard/README.md). |
| [`apps/pipeline`](apps/pipeline) | Node ESM scripts | Parsers and loaders that seed the **content library** tables (recipes, facts, quotes, prompts, on_this_day, articles, pdr_questions, birthdays, name_days, jokes, assets, tg_posts). The editor reads these through `search_library`. |

```
ai0_global/
├── apps/
│   ├── automation/          # NestJS service (src/, config/, editor-skills/, .claude/skills/)
│   ├── dashboard/           # React SPA
│   └── pipeline/            # src/{parsers,loaders,lib,data,raw-data,tools}
├── database/
│   ├── init.sql             # baseline schema for a fresh DB (idempotent)
│   ├── migrations/NNN_*.sql # forward-only, idempotent migrations
│   ├── migrate.sh           # applies pending migrations via the compose postgres
│   └── ci-bootstrap-check.sh# CI: fresh DB from init.sql + all migrations
├── specs/                   # feature specs (Spec Kit layout), see specs/README.md
├── docs/runbooks/           # operational runbooks
├── docs/reference/          # design references
├── docker-compose.yml       # postgres, redis, automation+dashboard (prod), backup, pipeline
└── .env.example
```

## Local setup

```bash
pnpm install
cp .env.example .env              # fill in Postgres creds, bot tokens, OPENROUTER_API_KEY, …
pnpm db:up                        # Postgres in docker (Redis: docker compose up -d redis)
pnpm db:init                      # fresh DB: apply database/init.sql (idempotent)
pnpm db:migrate                   # apply database/migrations/* (also runs at service boot)
pnpm --filter pipeline run load:all   # optional: seed the content library
pnpm dev:automation               # NestJS on :3000 (NODE_ENV=local-development)
pnpm --filter dashboard run dev   # dashboard on :5173, proxies /api to :3000
```

The dashboard needs its own `apps/dashboard/.env` (copy `apps/dashboard/.env.example`). See the
[dashboard README](apps/dashboard/README.md).

## Root scripts

| Script | What it runs |
|--------|--------------|
| `pnpm db:up` / `db:down` | start or stop the compose `postgres` service |
| `pnpm db:init` | `pipeline init-db`: apply `database/init.sql` to an empty or existing DB (formerly `pnpm migrate`) |
| `pnpm db:migrate` | `bash database/migrate.sh`: apply pending migrations, recorded in `schema_migrations` |
| `pnpm dev:automation` | automation in watch mode |
| `pnpm prod:up` / `prod:down` / `prod:logs` | compose `prod` profile (automation + dashboard) |
| `pnpm pipeline:parse` / `pipeline:load` / `pipeline:sync` | the pipeline in its container: `parse`, `load:all`, or both |

## Database and migrations

- `database/init.sql` is the baseline for a fresh database. Every statement is `IF NOT EXISTS`.
- New schema always goes in `database/migrations/NNN_name.sql`. Migrations are idempotent and
  additive, and each records its own version in `schema_migrations`.
- They are applied two ways, sharing the same ledger:
  - `pnpm db:migrate` (`database/migrate.sh`, psql inside the compose `postgres`), run on deploy
    before (re)starting automation;
  - the automation **boot runner** (`MigrationRunnerService`, under a Postgres advisory lock),
    which applies anything still pending at startup.
- CI (`.github/workflows/ci-feature.yml`, job `schema-bootstrap`) builds a fresh Postgres 16 from
  `init.sql` and every migration, then re-applies `042+` to prove idempotency.
- Retention: a nightly job prunes old logs and run traces and blanks old message text. It is on via
  `RETENTION_ENABLED=true` in `.env.example`; see the per-table windows there. `bot_logs` is
  never pruned.
- Backups: [docs/runbooks/backup-restore.md](docs/runbooks/backup-restore.md).

## Editor agent

Each channel has an autonomous editor (planner, executor and reviewer) that writes posts at decision
time from the web and the content library. Every channel starts in **shadow** mode and goes `live`
only when the owner flips it. `EDITOR_ENABLED` is the global kill switch.
See the runbook: [docs/runbooks/editor-agent.md](docs/runbooks/editor-agent.md).

## Pipeline (content library)

Run these from `apps/pipeline` (`pnpm --filter pipeline run <script>`):

- `parse`: runs every parser in `src/parsers` that has a default export. This includes
  `recipes-epicure`, which regenerates the gitignored `data/normalized/recipes/recipes.json`.
- `load:all`: assets, prompts, prompts-github, daytoday (on_this_day, articles, jokes, quotes,
  name_days, birthdays), treatfield, recipes, facts, pdr and tg-posts. Every loader is
  `ON CONFLICT DO NOTHING`.
- `db:seed` = `init-db` + `load:all`, and `sync` = `parse` + `load:all`.
- `load:recipes:fresh` refreshes the source columns of existing recipes. It requires
  `ALLOW_TRUNCATE=yes` and keeps translations, Telegraph pages and `posted`.
- `init-db:reset` drops every table. It requires `ALLOW_DB_RESET=yes` and never runs with
  `NODE_ENV=production`.

Library rows carry `source_name`, `source_url` and `license` (migration 043). Raw scraped sources
(about 161 MB) live in `apps/pipeline/src/raw-data` and stay out of the Docker images. See
[docs/runbooks/raw-data.md](docs/runbooks/raw-data.md).

## Configuration

- Secrets and toggles: `.env` (template: `.env.example`).
- Bots, channels and strategy bindings live in **Postgres** and are edited from the dashboard.
- `apps/automation/config/channels.json` (with `channels-dev.json` / `channels.local.json` for
  dev) is **legacy**. `JsonImporterService` imports it once per environment on first boot, guarded
  by a `config_imported_<env>` sentinel. After that it is ignored, so do not edit it to change
  production. `channels.local.json` is a gitignored overlay for `NODE_ENV=local-development`.

## Tests and CI

```bash
pnpm --filter automation test                          # node:test + tsx, offline fakes only
pnpm --filter automation exec tsc --noEmit -p tsconfig.json
pnpm --filter automation run lint
pnpm --filter pipeline test                            # node --test
pnpm --filter dashboard exec tsc --noEmit -p tsconfig.json
```

During development nobody starts the service, triggers publishes or calls paid or external APIs. The
owner runs live tests and applies migrations. CI runs the automation and dashboard checks plus the
schema bootstrap on every `feat/**`, `fix/**` and `feature/**` push and on every PR.

## Docs

- Specs index and status: [specs/README.md](specs/README.md)
- Constitution: [.specify/memory/constitution.md](.specify/memory/constitution.md)
- Runbooks: [editor agent](docs/runbooks/editor-agent.md), [prod release](docs/runbooks/prod-release.md),
  [dev-stage server](docs/runbooks/dev-stage-server-setup.md), [backup and restore](docs/runbooks/backup-restore.md),
  [raw data](docs/runbooks/raw-data.md), [repo history purge](docs/runbooks/repo-history-purge.md) (owner-only)
- Dashboard design reference (Framer-style tokens):
  [docs/reference/framer-design-reference.md](docs/reference/framer-design-reference.md)
