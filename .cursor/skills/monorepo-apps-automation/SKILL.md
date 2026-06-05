---
name: monorepo-apps-automation
description: >-
  ai0_global apps/automation: NestJS 10, content strategies, scheduler, publishers, raw pg.
  Use when adding or changing strategies, DB-backed posting, dedup (posted_news / posted jsonb),
  channels.json scheduling, or anything under apps/automation.
---

# Coding guide: `apps/automation`

## Stack

- **NestJS 10**, TypeScript, **raw `pg`** (no ORM).
- **Config**: `ConfigModule` global, `envFilePath: '../../.env'` (repo root).
- **Scheduling**: `@nestjs/schedule` + `SchedulerService` — cron jobs from `config/channels.json` (or `channels-dev.json` when `NODE_ENV=development`).

## Layout

- **Feature strategies**: `src/strategies/<name>/` — `*.strategy.ts`, `*-strategy.module.ts`, optional `*.repository.ts`, prompts under strategy or `src/common/ai/`.
- **Cross-cutting**: `src/common/` (content-strategy runner/registry, AI, dedup), `src/publishers/`, `src/scheduler/`, `src/database/`, `src/config/`.
- **Channels** are publish targets only; **logic lives in strategies**.

---

## Two execution paths

1. **Standard pipeline** (`ContentStrategyRunner`):  
   `fetch` → `DedupService` (`posted_news`) → `generate` → review (AI) → publish → `markPosted`.  
   Implement `fetch`, `generate`, `getSkills`. Do **not** implement `execute`.

2. **Custom pipeline** (`execute`):  
   Full control (batch fetch, per-row `posted` jsonb, skip review). Stub `fetch` / `generate` returning `null` if unused.

References: `src/common/content-strategy/content-strategy.interface.ts`, `content-strategy.runner.ts`, `scheduler/scheduler.service.ts`.

---

## Database: data shape and tables

- **Canonical schema**: **`database/init.sql`** — all content and infra tables/columns/indexes.
- **Access**: inject **`DB_POOL`** from `DatabaseModule` into a `*.repository.ts`; define **row types** that match your `SELECT` columns (see `strategies/facts/facts.repository.ts`).

### `posted` jsonb vs `posted_news`

Many content tables use **`posted jsonb`**: keys are **channel ids** (same strings as in `config/channels.json`), values are timestamps.

```sql
WHERE NOT (posted ? $1)
UPDATE ... SET posted = posted || jsonb_build_object($2, NOW())
```

Examples in `init.sql`: `facts`, `quotes`, `articles`, `jokes`, `recipes`, `on_this_day`, `birthdays`, `pdr_questions`, `tg_posts`, `assets`, `prompts`, etc.

The **standard runner** dedupes by **URL** in **`posted_news`** (`source_url`, `channel_id`). `DedupService` filters before generate and inserts after publish. Set a stable **`sourceUrl`** in `StrategyFetchResult`.

| Question | Mechanism |
|----------|-----------|
| Already posted this **URL** to this channel? | `posted_news` + `DedupService` |
| Already posted this **row** to this channel? | Row’s `posted` jsonb + channel id |
| Diagnostics | `bot_logs`, `ai_logs` (follow existing strategies) |

New columns/tables: align **`database/init.sql`** with **`apps/pipeline`** loaders (uniqueness: hashes, slugs, etc.).

---

## Adding a new content strategy (step by step)

1. **Folder** `src/strategies/<your-name>/`: strategy class, Nest module, optional repository.
2. **`readonly type = 'your-type'`** — must match `strategies[].type` in channel config.
3. **`onModuleInit()`**: `this.registry.register(this)` via `ContentStrategyRegistry`.
4. **Import** `<YourName>StrategyModule` in **`src/app.module.ts`**.
5. **Config** — add an entry to **`strategies[]`** in `config/channels.json` (or dev file):
   - `id`, `type`, `channelId`, optional `schedule`, `postDelayMinutes`, `params` (`StrategyParams`).

**Pipeline choice**

- **URL-based feeds / news**: standard path — stable `sourceUrl`, implement `generate` + `getSkills`.
- **DB rows with `posted` jsonb**: often **`execute`** — pick unposted row, publish, update `posted`.

## Examples to mirror

| Pattern | Location |
|---------|----------|
| Repository + `posted` jsonb | `strategies/facts/` |
| Standard fetch + dedup + generate | `strategies/space/space.strategy.ts` |
| Custom `execute`, multiple sources | `strategies/game-channel/game-channel.strategy.ts` |
| Module wiring | any `*-strategy.module.ts` under `strategies/` |

---

## Commands

- Dev: `pnpm --filter automation run start:dev`
- Lint / build: `pnpm --filter automation run lint` / `build`

Postgres: repo-root **`.env`** → `POSTGRES_*` as used by `DatabaseModule`.

---

## Scope

- Do not change `apps/pipeline` for automation-only work.
- Schema changes: coordinate **`database/init.sql`** and consumers; use a **database** task/agent when appropriate.
