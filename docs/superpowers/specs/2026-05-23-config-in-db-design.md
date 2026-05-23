# Config in DB — Phase 5 Design

**Date:** 2026-05-23
**Status:** approved (brainstorm phase) — pending plan
**Branch:** `feat/config-in-db` (off `feat/graph-and-roi`)
**Predecessors:**
- `2026-05-20-discovery-recommendations-design.md` (Phase 4)
- `2026-05-13-channel-tracking-platform-design.md` (Phase 1–3)

## Goal

Move every concept currently held in `apps/automation/config/channels*.json`
(bots, channels, strategy bindings, forward routes, proxies) into Postgres,
manageable through dashboard CRUD pages. Operator never touches a JSON file or
restarts automation to wire a new channel / strategy / bot.

Keep `tokenEnv` indirection: the JSON `tokenEnv: "TELEGRAM_BOT_TOKEN"` pattern
moves to a `my_bots.token_env` column. Real tokens stay in `.env`, never in
the database. For ≤10 bots that's the right safety/UX balance — encryption-
in-DB is deferred (Phase 5d candidate).

Three independent phases, each its own PR:
- **5a — Foundation** (sidebar UX + bots + JSON→DB import + service refactor)
- **5b — Channels enhanced** (smart Add modal, `is_mine` & themes UI)
- **5c — Strategies** (CRUD + cron next-runs visibility + live reload)

## Non-goals

- Encrypting tokens in DB (Phase 5d if needed).
- Per-operator multi-tenancy. Single-operator system stays.
- Replacing `apps/automation/.claude/skills/` (those stay file-based).
- Replacing `apps/automation/config/sources/*.json` (RSS source lists stay
  file-based for now — could move to DB later but not in scope here).

## Today's surface (what we're replacing)

`apps/automation/src/config/channel-config.service.ts:140` resolves env →
file (`channels.json`, `channels-dev.json`, `channels.local.json`). The JSON
contains:

```jsonc
{
  "bots":       { "<bot_id>": { "platform", "tokenEnv" } },
  "channels":   { "<channel_key>": { "platform", "chatId", "botId", "forwardRoutes": [...] } },
  "strategies": [{ "id", "type", "channelId", "schedule", "params" }]
}
```

Consumers: `SchedulerService`, every strategy, `DiscoveryController.themes`,
`TelegramPublisher`, etc. all call `ChannelConfigService.resolveChannel(id)`
or `.resolveStrategyBindings()`. **API stays unchanged** — only the data
source moves.

## Data model

### `my_bots`
```sql
CREATE TABLE my_bots (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id            TEXT UNIQUE NOT NULL,        -- 'ai0_global_test_bot' (logical key, matches old JSON)
  username          TEXT,                          -- '@ai0_global_test_bot' after getMe verification
  first_name        TEXT,                          -- 'AI test bot' after getMe
  platform          TEXT NOT NULL DEFAULT 'telegram',
  token_env         TEXT NOT NULL,                 -- 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN_2', …
  active            BOOLEAN NOT NULL DEFAULT true,
  last_verified_at  TIMESTAMPTZ,
  verify_error      TEXT,                          -- last getMe error if any
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Extend `tracked_channels`

`tracked_channels` already exists (from Phase 1) with `id`, `username`,
`tg_chat_id`, `title`, `themes`, `is_mine`. Add:

```sql
ALTER TABLE tracked_channels
  ADD COLUMN IF NOT EXISTS channel_key TEXT,                      -- legacy id from channels.json ('@motivation_local')
  ADD COLUMN IF NOT EXISTS kind        TEXT,                      -- 'public' | 'private' | NULL
  ADD COLUMN IF NOT EXISTS bot_id      UUID REFERENCES my_bots(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tracked_channels_channel_key
  ON tracked_channels (channel_key) WHERE channel_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracked_channels_bot ON tracked_channels (bot_id);
```

`kind` is derived: `tg_chat_id IS NOT NULL` → `private`, `username IS NOT NULL` → `public`. Stored explicitly so the UI can render it without inference.

### `strategy_bindings`
```sql
CREATE TABLE strategy_bindings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ext_id      TEXT UNIQUE NOT NULL,                                -- 'quotes:local_motivation' — matches existing JSON
  type        TEXT NOT NULL,                                       -- 'quotes' | 'birthday-strategy' | 'facts' | …
  channel_id  UUID NOT NULL REFERENCES tracked_channels(id) ON DELETE CASCADE,
  schedule    TEXT NOT NULL,                                       -- cron expression
  params      JSONB NOT NULL DEFAULT '{}',
  enabled     BOOLEAN NOT NULL DEFAULT true,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_strategy_bindings_channel ON strategy_bindings (channel_id);
CREATE INDEX idx_strategy_bindings_type    ON strategy_bindings (type);
CREATE INDEX idx_strategy_bindings_enabled ON strategy_bindings (enabled);
```

### `forward_routes`
```sql
CREATE TABLE forward_routes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_channel_id UUID NOT NULL REFERENCES tracked_channels(id) ON DELETE CASCADE,
  target_channel_id UUID NOT NULL REFERENCES tracked_channels(id) ON DELETE CASCADE,
  topic             TEXT NOT NULL,                                 -- 'gaming' | 'ai_tech' | 'motivation'
  description       TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_channel_id, topic)
);
```

`proxies` stay in `proxies.json` until someone adds enough operator-friction
to demand UI — not in this spec.

## ChannelConfigService refactor

Public API unchanged:
- `resolveChannel(channelKey | id): ResolvedChannel`
- `resolveStrategyBindings(): ResolvedStrategyBinding[]`
- `getForwardRoutes(channelKey): ForwardRoute[]`

Internally:
1. Boot: load everything from DB into in-memory caches (`Map<key, …>`).
2. On `config:changed` Redis pub/sub event → reload caches in place.
3. Existing strategies + scheduler keep their hot path (`resolveChannel`)
   — they hit cache, no per-call DB query.

Bootstrap migration: if `my_bots` is empty on boot AND `channels.<env>.json`
file exists, the service performs a one-shot import (`migrateFromJson()`) that
seeds tables from the legacy JSON, then marks `schema_migrations` with a
`config_imported_<env>` sentinel so it never re-runs. JSON files remain on
disk as backup but are not consulted again.

## Phase 5a — Foundation

### Sidebar refactor (UI scaffolding first)

Why first: the new pages (`/bots`, `/strategies`) need a place to live. The
current top-nav is already crowded. Doing the sidebar before adding pages
avoids a second layout re-flow later.

New component `apps/dashboard/src/components/Sidebar.tsx`:
- Collapsed (default ~64px wide) shows icons only
- Expanded (~220px wide) shows icons + labels
- Toggle button at bottom
- Active route highlighting matches existing `activeProps`
- Items: Channels, Discovery, Graph, Recommendations, **Bots** (placeholder enabled), **Strategies** (placeholder, disabled until 5c)

`Layout.tsx` reworked:
- Sidebar on left (sticky)
- Header trimmed to: app title (left), user identity + logout (right)
- Main content area gets the remaining width

### DB migration `005_config.sql`

Creates `my_bots`, `strategy_bindings`, `forward_routes`. ALTERs
`tracked_channels` with `channel_key`, `kind`, `bot_id`. Records
`schema_migrations` entry `005_config`. Idempotent.

### One-time JSON → DB importer

`apps/automation/src/config/json-importer.service.ts`. Runs in
`onApplicationBootstrap()`. Pseudocode:

```ts
if (await migrationsRepo.has('config_imported_<env>')) return;
const json = readFileSync(resolveConfigPath(env));
await tx(async () => {
  for (const [botId, b] of Object.entries(json.bots)) {
    await myBots.insert({ bot_id: botId, token_env: b.tokenEnv, ... });
  }
  for (const [chKey, ch] of Object.entries(json.channels)) {
    await trackedChannels.upsert({
      channel_key: chKey,
      kind: chKey.startsWith('@') ? 'public' : 'private',
      tg_chat_id: chKey.startsWith('-') ? Number(chKey) : null,
      username: chKey.startsWith('@') ? chKey.slice(1) : null,
      bot_id: lookupBot(ch.botId).id,
      is_mine: true,  // anything in channels.json is operator-owned
    });
    for (const r of ch.forwardRoutes ?? []) {
      await forwardRoutes.insert({ source: ..., target: lookupChannel(r.channelId), ... });
    }
  }
  for (const s of json.strategies) {
    await strategyBindings.insert({
      ext_id: s.id, type: s.type, channel_id: lookupChannel(s.channelId).id,
      schedule: s.schedule, params: s.params ?? {},
      enabled: true,
    });
  }
  await migrationsRepo.mark('config_imported_<env>');
});
```

Comments stripping: `_comment`, `_name`, `_inviteLink` keys in the JSON are
ignored. Already-present rows (by unique key) get `ON CONFLICT DO NOTHING`.

### ChannelConfigService rewrite

- Drop `JSON.parse(readFileSync(...))`.
- Add `ConfigCache` (in-memory `Maps` of bots, channels, bindings, forward
  routes).
- `onApplicationBootstrap()`: hydrate cache from DB.
- Subscribe to Redis pub/sub channel `config:changed`. Any operator-side
  mutation publishes; service reloads cache.
- Public API methods (`resolveChannel`, etc.) read from cache.

### New REST API: bots

```
GET    /api/my-bots                    → [{ id, bot_id, username, first_name, token_env, active, last_verified_at, verify_error }]
POST   /api/my-bots         body: { bot_id, token_env }   → 201, new row
POST   /api/my-bots/:id/verify         → calls Telegram getMe, updates username/first_name/last_verified_at OR verify_error
PATCH  /api/my-bots/:id     body: { active? }             → enable/disable
DELETE /api/my-bots/:id                                    → 204, fails 409 if any channel still bound
```

All endpoints under `TrackingAuthGuard` (existing dev-bypass works locally).

### UI page `/bots`

`apps/dashboard/src/routes/bots.tsx`:
- Table: bot_id | username | env | status (✓ active / ⚠ unverified) | last verified | actions
- "Verify" button → POST `/verify`
- "+ Add bot" modal → inputs `bot_id` (label) + `token_env` (e.g. `TELEGRAM_BOT_TOKEN_2`)
- Hint text: "After adding the bot, set `<TOKEN_ENV>=...` in your `.env` and click Verify."
- Deletion guarded if channels still bound.

### Deliverable for 5a
- Sidebar layout shipped.
- Operator can manage bots through `/bots`.
- Old JSON files still on disk (as backup / for fresh boots without DB), but boot reads from DB.
- Channels + strategies still come from JSON-imported rows (no UI to mutate them yet).

## Phase 5b — Channels enhanced

### Smart `AddChannelModal`

New component, replaces existing `apps/dashboard/src/components/AddChannelModal.tsx`.

Behaviour:
- Field "Identifier" + select "Type" (Public | Private) wired bidirectionally.
- Detection: input starts with `@` → Public; starts with `-100` → Private; pasted `https://t.me/...` → strip prefix and detect.
- Public: `chat_identifier` = `@xxx`, stored as `username = 'xxx'`.
- Private: `chat_identifier` = `-100…`, stored as `tg_chat_id = …`.
- Invite links (`https://t.me/+abc`) rejected in MVP with hint "use numeric chat ID — get it from Telegram Web URL".
- Field "Bot" — dropdown of `my_bots WHERE active=true`.
- Submit → POST `/tracking/channels` extended to accept `{ identifier, kind?, botId }`; auto-detect kind from identifier when not passed.

### Backend changes

`POST /tracking/channels` extended:
```ts
body: { identifier: string, botId: string, kind?: 'public' | 'private' }
```

Logic: detect kind from identifier if absent, parse, write to `tracked_channels` with `is_mine = true`, `bot_id = ...`, `channel_key = identifier`.

`PATCH /tracking/channels/:id` body `{ isMine?: boolean, themes?: string[] }` (used by channel-detail page).

### UI: Channel detail page

Add toggle "Is mine" + reuse existing `<EditThemesModal />` (from Phase 4) but allow it on non-mine channels too. Themes column already in DB.

### Deliverable for 5b

Operator can add a private channel through UI in 4 clicks — pick bot,
paste `-100…`, submit. No JSON edits, no restart. After 5b, the `channels`
section of `channels.<env>.json` is *no longer read* (importer marks
`channels_imported_<env>`).

## Phase 5c — Strategies + cron visibility

### CRUD endpoints

```
GET    /api/strategy-bindings                 → list
POST   /api/strategy-bindings  body: { type, channelId, schedule, params, enabled }
PATCH  /api/strategy-bindings/:id   body: { schedule?, params?, enabled? }
DELETE /api/strategy-bindings/:id
GET    /api/strategy-types                    → list of registered types from ContentStrategyRegistry
GET    /api/strategy-bindings/:id/next-runs   → next N cron firings, e.g. ?count=5
```

### UI page `/strategies`

`apps/dashboard/src/routes/strategies.tsx`:
- Filter row: type, channel, enabled
- Table columns: ext_id | type | channel | schedule | next run | last run | enabled toggle | actions (edit / delete)
- "+ Add strategy" modal:
  - Type ▼ (from `/api/strategy-types`)
  - Channel ▼ (from `tracked_channels`)
  - Schedule input — text field + **cron preset chips** (`* * * * *`, `0 11 * * *`, `*/30 8-22 * * *`, etc.) — clicking a chip fills the field
  - Params JSON editor (Monaco-like — but we can start with a textarea + JSON.parse validation)
  - Enabled checkbox
- **Next-runs inline view**: each row expands to show next 5 fires computed by `cron-parser` library

### Live reload (no restart)

Backend on any mutation → `redis.publish('config:changed', { kind: 'strategy_binding', id })`. `ChannelConfigService` reloads. `SchedulerService` extends to:
- Maintain a `Map<bindingExtId, CronJob>`
- On reload: diff old/new bindings, stop removed jobs, start added, update schedule on changed
- All without restarting Nest

### Cron parser dependency

`cron-parser` npm package — small, no transitive deps. Adds ~30 KB.

### Deliverable for 5c

`channels.<env>.json::strategies` section unused (importer marks
`strategies_imported_<env>`). Operator sees real-time next-fire ETAs in UI;
can flip strategies on/off without touching files.

## What stays in `channels.<env>.json` after all phases

After Phase 5c, JSON keeps only `proxies` (used by image-resolver microlink
proxies). Could move that later — out of this spec.

The empty JSON files become true "first-boot only" — if you wipe the DB and
re-boot, the importer re-seeds. Daily operation never touches them.

## Open assumptions / risks

| Risk | Mitigation |
|---|---|
| Importer runs twice and double-inserts | `ON CONFLICT DO NOTHING` on unique keys + `schema_migrations.config_imported_<env>` sentinel |
| DB write conflicts with cron firing (cache stale) | Pub/sub reload + 5-second debounce; cron in-flight guard already exists (`per-strategy in-flight guard`) so a stale schedule for one tick is harmless |
| `cron-parser` JS doesn't support all NestJS schedule formats | NestJS uses standard cron (5- or 6-field); cron-parser covers both. Validate at insert time. |
| Deleting a bot leaves orphaned channels | DELETE bot returns 409 if `tracked_channels.bot_id` references it; operator must reassign first |
| Sidebar regression breaks existing pages | Wrap rollout in a feature flag (`VITE_NEW_SIDEBAR=true`) for one release if anxious; otherwise just visual tests by walking each route |

## Testing plan

### Per-phase

5a:
- Unit: `JsonImporterService.migrateFromJson()` with fixture JSON → asserts row counts
- Unit: `MyBotsRepository.upsert` + `verify`
- Integration: boot with empty DB + fixture JSON → assert tables populated
- Manual: visit `/bots`, add fake bot, verify failure shows error

5b:
- Unit: `AddChannelModal` smart-detect tests (paste each format → expected kind)
- Integration: POST identifier `-1003984251759` + botId → 1 row in tracked_channels with `kind='private'`, `tg_chat_id=-1003984251759`, `bot_id=...`

5c:
- Unit: `next-runs(cron, count)` correctness
- Integration: PATCH binding `enabled=false` → SchedulerService unschedules within 5s
- Manual: change schedule from `*/5 * * * *` to `0 11 * * *` via UI → next-runs panel updates

### Manual smoke after each phase

Follow the cost-safe local dev flow (strip strategies → boot → exercise the new UI page).

## Verification on dev-stage after merge

For each phase, the deploy workflow ships the new image. To verify on dev-stage:

```bash
# 5a:
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c "
  SELECT bot_id, username, last_verified_at FROM my_bots;"
# Expect: rows for ai0_global_test_bot (env's existing bot)

# 5b:
# Open dashboard /channels → click + Add → paste -1003984251759 → pick bot → submit
# Verify row appears with kind='private', bot_id set

# 5c:
# Open /strategies → toggle a binding off → wait 10s → check the corresponding
# CronJob no longer fires (tail combined log for that ext_id)
```

## Phase order rationale

- **5a first** because: sidebar UX scaffolding makes 5b/5c easier; bots is the
  smallest atomic concept; importer is built once and reused.
- **5b second** because: channels are referenced by strategies — strategies
  table FKs `tracked_channels.id`. Without bot-binding being settable from UI,
  5c would still force JSON edits when adding a new channel.
- **5c last** because: scheduler reload is the trickiest piece, and by 5c the
  underlying data (channels, bots) is fully UI-managed.
