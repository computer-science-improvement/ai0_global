# Config in DB — Phase 5a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move bot configuration into Postgres, refactor `ChannelConfigService` to read from DB with Redis pub/sub hot reload, ship a collapsible sidebar in the dashboard, and add a `/bots` CRUD page.

**Architecture:** New `my_bots` table + extended `tracked_channels` columns (`channel_key`, `kind`, `bot_id`). One-shot `JsonImporterService` migrates the legacy `channels.<env>.json` into DB on first boot. `ChannelConfigService` keeps its public API but now hydrates from DB into an in-memory cache, reloading on Redis `config:changed` events. Dashboard gets a left sidebar + new `/bots` page.

**Tech Stack:** NestJS 10 + TypeScript, Postgres + pg, Redis (BullMQ already wires Redis client), React 18 + Tailwind v4 + TanStack Router/Query in the dashboard.

**Cost-safety:** No paid API calls in any task except the Telegram `getMe` verification — that's free.

---

## File map

### Backend — new
```
database/migrations/005_config.sql

apps/automation/src/config/
├── my-bots.repository.ts                          (NEW)
├── strategy-bindings.repository.ts                (NEW)
├── forward-routes.repository.ts                   (NEW)
├── tracked-channels.repository.ts                 (NEW — narrow read+upsert for tracked_channels)
├── json-importer.service.ts                       (NEW)
├── config-cache.service.ts                        (NEW — in-memory caches + reload)
├── config-events.publisher.ts                     (NEW — Redis pub/sub publisher)
├── config-events.types.ts                         (NEW — event payload shapes)
├── api/
│   ├── my-bots.controller.ts                      (NEW)
│   └── dto/my-bots.dto.ts                         (NEW)
└── telegram-getme.client.ts                       (NEW — Telegram bot getMe HTTP)
```

### Backend — modified
```
apps/automation/src/config/channel-config.service.ts    (rewrite internals; same public API)
apps/automation/src/config/config.module.ts             (register new providers/controllers)
apps/automation/src/tracking/redis.provider.ts          (export IORedis token for reuse if needed)
apps/automation/src/app.module.ts                       (no change — ChannelConfigModule already imported)
```

### Frontend — new
```
apps/dashboard/src/components/Sidebar.tsx
apps/dashboard/src/components/AddBotModal.tsx
apps/dashboard/src/api/bots.ts
apps/dashboard/src/routes/bots.tsx
```

### Frontend — modified
```
apps/dashboard/src/components/Layout.tsx          (sidebar + slim header)
apps/dashboard/src/api/types.ts                   (Bot type)
apps/dashboard/src/routeTree.gen.ts               (auto)
```

---

## Task 1 — DB migration 005_config

**Files:**
- Create: `database/migrations/005_config.sql`

- [ ] **Step 1: Write migration SQL**

```sql
-- 005_config.sql
-- Phase 5a: Move bot/channel/strategy config from channels.<env>.json into Postgres.

CREATE TABLE IF NOT EXISTS my_bots (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id            TEXT UNIQUE NOT NULL,
  username          TEXT,
  first_name        TEXT,
  platform          TEXT NOT NULL DEFAULT 'telegram',
  token_env         TEXT NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT true,
  last_verified_at  TIMESTAMPTZ,
  verify_error      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS strategy_bindings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ext_id      TEXT UNIQUE NOT NULL,
  type        TEXT NOT NULL,
  channel_id  UUID NOT NULL,
  schedule    TEXT NOT NULL,
  params      JSONB NOT NULL DEFAULT '{}',
  enabled     BOOLEAN NOT NULL DEFAULT true,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_strategy_bindings_channel ON strategy_bindings (channel_id);
CREATE INDEX IF NOT EXISTS idx_strategy_bindings_type    ON strategy_bindings (type);
CREATE INDEX IF NOT EXISTS idx_strategy_bindings_enabled ON strategy_bindings (enabled);

CREATE TABLE IF NOT EXISTS forward_routes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_channel_id UUID NOT NULL,
  target_channel_id UUID NOT NULL,
  topic             TEXT NOT NULL,
  description       TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_channel_id, topic)
);

ALTER TABLE tracked_channels
  ADD COLUMN IF NOT EXISTS channel_key TEXT,
  ADD COLUMN IF NOT EXISTS kind        TEXT,
  ADD COLUMN IF NOT EXISTS bot_id      UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tracked_channels_channel_key
  ON tracked_channels (channel_key) WHERE channel_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracked_channels_bot ON tracked_channels (bot_id);

-- Add the FKs now that all columns exist. Done as ALTER so the order of
-- column adds doesn't matter and re-running the migration is safe.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_strategy_bindings_channel') THEN
    ALTER TABLE strategy_bindings
      ADD CONSTRAINT fk_strategy_bindings_channel
      FOREIGN KEY (channel_id) REFERENCES tracked_channels(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_forward_routes_source') THEN
    ALTER TABLE forward_routes
      ADD CONSTRAINT fk_forward_routes_source
      FOREIGN KEY (source_channel_id) REFERENCES tracked_channels(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_forward_routes_target') THEN
    ALTER TABLE forward_routes
      ADD CONSTRAINT fk_forward_routes_target
      FOREIGN KEY (target_channel_id) REFERENCES tracked_channels(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tracked_channels_bot') THEN
    ALTER TABLE tracked_channels
      ADD CONSTRAINT fk_tracked_channels_bot
      FOREIGN KEY (bot_id) REFERENCES my_bots(id) ON DELETE SET NULL;
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('005_config')
  ON CONFLICT (version) DO NOTHING;
```

- [ ] **Step 2: Apply migration**

```bash
docker exec -i ai0_global-postgres-1 psql -U ai0 -d ai0global \
  < database/migrations/005_config.sql
```

Expected output: a series of `CREATE TABLE` / `CREATE INDEX` / `ALTER TABLE` / `DO` / `INSERT 0 1`.

- [ ] **Step 3: Verify**

```bash
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c "\d my_bots" | head -15
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c "\d strategy_bindings" | head -15
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c "
  SELECT column_name FROM information_schema.columns
  WHERE table_name='tracked_channels' AND column_name IN ('channel_key','kind','bot_id');"
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c "
  SELECT version FROM schema_migrations WHERE version='005_config';"
```

Expect: `my_bots` shown with 11 columns, `strategy_bindings` shown with 8 columns, 3 new columns on `tracked_channels`, sentinel row.

- [ ] **Step 4: Commit**

```bash
git add database/migrations/005_config.sql
git commit -m "feat(config): 005 migration — my_bots, strategy_bindings, forward_routes + tracked_channels columns"
```

---

## Task 2 — MyBotsRepository

**Files:**
- Create: `apps/automation/src/config/my-bots.repository.ts`

- [ ] **Step 1: Write the repository**

```ts
// apps/automation/src/config/my-bots.repository.ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

export interface MyBotRow {
  id:                string;
  bot_id:            string;
  username:          string | null;
  first_name:        string | null;
  platform:          string;
  token_env:         string;
  active:            boolean;
  last_verified_at:  Date | null;
  verify_error:      string | null;
  created_at:        Date;
}

export interface MyBotInsertInput {
  bot_id:    string;
  token_env: string;
  platform?: string;
}

@Injectable()
export class MyBotsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async list(): Promise<MyBotRow[]> {
    const { rows } = await this.pool.query<MyBotRow>(
      `SELECT * FROM my_bots ORDER BY created_at`,
    );
    return rows;
  }

  async findById(id: string): Promise<MyBotRow | null> {
    const { rows } = await this.pool.query<MyBotRow>(
      `SELECT * FROM my_bots WHERE id = $1`, [id],
    );
    return rows[0] ?? null;
  }

  async findByBotId(botId: string): Promise<MyBotRow | null> {
    const { rows } = await this.pool.query<MyBotRow>(
      `SELECT * FROM my_bots WHERE bot_id = $1`, [botId],
    );
    return rows[0] ?? null;
  }

  async insert(input: MyBotInsertInput): Promise<MyBotRow> {
    const { rows } = await this.pool.query<MyBotRow>(
      `INSERT INTO my_bots (bot_id, token_env, platform)
       VALUES ($1, $2, COALESCE($3, 'telegram'))
       RETURNING *`,
      [input.bot_id, input.token_env, input.platform ?? null],
    );
    return rows[0];
  }

  async markVerified(id: string, meta: { username: string; first_name: string }): Promise<void> {
    await this.pool.query(
      `UPDATE my_bots
         SET username         = $2::text,
             first_name       = $3::text,
             last_verified_at = now(),
             verify_error     = NULL
       WHERE id = $1`,
      [id, meta.username, meta.first_name],
    );
  }

  async markVerifyError(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE my_bots SET verify_error = $2::text, last_verified_at = now() WHERE id = $1`,
      [id, error],
    );
  }

  async setActive(id: string, active: boolean): Promise<void> {
    await this.pool.query(`UPDATE my_bots SET active = $2 WHERE id = $1`, [id, active]);
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM my_bots WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }

  async countChannelsBound(id: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text FROM tracked_channels WHERE bot_id = $1`, [id],
    );
    return parseInt(rows[0].count, 10);
  }
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm --filter automation exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/automation/src/config/my-bots.repository.ts
git commit -m "feat(config): MyBotsRepository (CRUD + verify state)"
```

---

## Task 3 — Tracked channels repository (narrow read+upsert)

**Files:**
- Create: `apps/automation/src/config/tracked-channels.repository.ts`

(We need a slim repo because the existing `tracking/` repository is heavier — has poll-tier and post counts. For config-level CRUD we want a focused interface.)

- [ ] **Step 1: Write the repository**

```ts
// apps/automation/src/config/tracked-channels.repository.ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

export interface TrackedChannelConfigRow {
  id:           string;
  channel_key:  string | null;
  username:     string | null;
  tg_chat_id:   string | null;       // bigint → string from pg
  title:        string | null;
  kind:         'public' | 'private' | null;
  bot_id:       string | null;
  is_mine:      boolean;
  themes:       string[];
}

export interface TrackedChannelUpsertInput {
  channel_key:  string;
  username:     string | null;
  tg_chat_id:   number | string | null;
  kind:         'public' | 'private';
  bot_id:       string | null;
  is_mine:      boolean;
}

@Injectable()
export class TrackedChannelsConfigRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async list(): Promise<TrackedChannelConfigRow[]> {
    const { rows } = await this.pool.query<TrackedChannelConfigRow>(
      `SELECT id, channel_key, username, tg_chat_id::text AS tg_chat_id,
              title, kind, bot_id, is_mine, themes
       FROM tracked_channels
       ORDER BY added_at`,
    );
    return rows;
  }

  async findByChannelKey(channelKey: string): Promise<TrackedChannelConfigRow | null> {
    const { rows } = await this.pool.query<TrackedChannelConfigRow>(
      `SELECT id, channel_key, username, tg_chat_id::text AS tg_chat_id,
              title, kind, bot_id, is_mine, themes
       FROM tracked_channels WHERE channel_key = $1`,
      [channelKey],
    );
    return rows[0] ?? null;
  }

  /** Upsert by channel_key. Idempotent. Returns the id. */
  async upsertByKey(input: TrackedChannelUpsertInput): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO tracked_channels
         (channel_key, username, tg_chat_id, kind, bot_id, is_mine, poll_tier)
       VALUES ($1, $2, $3, $4, $5, $6, 'warm')
       ON CONFLICT (channel_key) WHERE channel_key IS NOT NULL DO UPDATE SET
         username   = EXCLUDED.username,
         tg_chat_id = EXCLUDED.tg_chat_id,
         kind       = EXCLUDED.kind,
         bot_id     = EXCLUDED.bot_id,
         is_mine    = EXCLUDED.is_mine
       RETURNING id`,
      [
        input.channel_key,
        input.username,
        input.tg_chat_id,
        input.kind,
        input.bot_id,
        input.is_mine,
      ],
    );
    return rows[0].id;
  }
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm --filter automation exec tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add apps/automation/src/config/tracked-channels.repository.ts
git commit -m "feat(config): TrackedChannelsConfigRepository (narrow read+upsert by channel_key)"
```

---

## Task 4 — Strategy bindings + forward routes repositories

**Files:**
- Create: `apps/automation/src/config/strategy-bindings.repository.ts`
- Create: `apps/automation/src/config/forward-routes.repository.ts`

- [ ] **Step 1: Write `strategy-bindings.repository.ts`**

```ts
// apps/automation/src/config/strategy-bindings.repository.ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

export interface StrategyBindingRow {
  id:          string;
  ext_id:      string;
  type:        string;
  channel_id:  string;
  schedule:    string;
  params:      Record<string, unknown>;
  enabled:     boolean;
  notes:       string | null;
}

export interface StrategyBindingInsertInput {
  ext_id:     string;
  type:       string;
  channel_id: string;
  schedule:   string;
  params:     Record<string, unknown>;
  enabled?:   boolean;
}

@Injectable()
export class StrategyBindingsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async list(): Promise<StrategyBindingRow[]> {
    const { rows } = await this.pool.query<StrategyBindingRow>(
      `SELECT id, ext_id, type, channel_id, schedule, params, enabled, notes
       FROM strategy_bindings
       ORDER BY ext_id`,
    );
    return rows;
  }

  async insertIfMissing(input: StrategyBindingInsertInput): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO strategy_bindings (ext_id, type, channel_id, schedule, params, enabled)
       VALUES ($1, $2, $3, $4, $5::jsonb, COALESCE($6, true))
       ON CONFLICT (ext_id) DO NOTHING`,
      [
        input.ext_id, input.type, input.channel_id, input.schedule,
        JSON.stringify(input.params), input.enabled ?? true,
      ],
    );
    return (rowCount ?? 0) > 0;
  }
}
```

- [ ] **Step 2: Write `forward-routes.repository.ts`**

```ts
// apps/automation/src/config/forward-routes.repository.ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

export interface ForwardRouteRow {
  id:                 string;
  source_channel_id:  string;
  target_channel_id:  string;
  topic:              string;
  description:        string;
}

export interface ForwardRouteInsertInput {
  source_channel_id: string;
  target_channel_id: string;
  topic:             string;
  description:       string;
}

@Injectable()
export class ForwardRoutesRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async list(): Promise<ForwardRouteRow[]> {
    const { rows } = await this.pool.query<ForwardRouteRow>(
      `SELECT id, source_channel_id, target_channel_id, topic, description
       FROM forward_routes
       ORDER BY topic`,
    );
    return rows;
  }

  async insertIfMissing(input: ForwardRouteInsertInput): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO forward_routes (source_channel_id, target_channel_id, topic, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (source_channel_id, topic) DO NOTHING`,
      [input.source_channel_id, input.target_channel_id, input.topic, input.description],
    );
    return (rowCount ?? 0) > 0;
  }
}
```

- [ ] **Step 3: Type-check**

```bash
pnpm --filter automation exec tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add apps/automation/src/config/strategy-bindings.repository.ts \
        apps/automation/src/config/forward-routes.repository.ts
git commit -m "feat(config): StrategyBindings + ForwardRoutes repositories (list + insertIfMissing)"
```

---

## Task 5 — Telegram getMe client

**Files:**
- Create: `apps/automation/src/config/telegram-getme.client.ts`

- [ ] **Step 1: Write the client**

```ts
// apps/automation/src/config/telegram-getme.client.ts
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface TelegramGetMeResult {
  id:         number;
  is_bot:     boolean;
  first_name: string;
  username:   string;
}

@Injectable()
export class TelegramGetMeClient {
  private readonly logger = new Logger(TelegramGetMeClient.name);

  /** Returns getMe result or throws with a human message. */
  async getMe(token: string): Promise<TelegramGetMeResult> {
    if (!token || token.length < 30) {
      throw new Error('Token looks malformed (too short)');
    }
    try {
      const res = await axios.get(
        `https://api.telegram.org/bot${token}/getMe`,
        { timeout: 8000 },
      );
      const body = res.data;
      if (!body?.ok || !body.result) {
        throw new Error(`Telegram API rejected: ${body?.description ?? 'unknown'}`);
      }
      return body.result;
    } catch (err: any) {
      const desc = err?.response?.data?.description ?? err.message;
      throw new Error(`getMe failed: ${desc}`);
    }
  }
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm --filter automation exec tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add apps/automation/src/config/telegram-getme.client.ts
git commit -m "feat(config): TelegramGetMeClient (validates bot token via /getMe)"
```

---

## Task 6 — JsonImporterService

**Files:**
- Create: `apps/automation/src/config/json-importer.service.ts`

- [ ] **Step 1: Write the importer**

```ts
// apps/automation/src/config/json-importer.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { MyBotsRepository } from './my-bots.repository';
import { TrackedChannelsConfigRepository } from './tracked-channels.repository';
import { StrategyBindingsRepository } from './strategy-bindings.repository';
import { ForwardRoutesRepository } from './forward-routes.repository';

interface RawJsonConfig {
  bots?: Record<string, { platform?: string; tokenEnv: string }>;
  channels?: Record<string, {
    platform?: string;
    chatId?:   string;
    botId?:    string;
    forwardRoutes?: Array<{ topic: string; channelId: string; description: string }>;
  }>;
  strategies?: Array<{
    id:        string;
    type:      string;
    channelId: string;
    schedule:  string;
    params?:   Record<string, unknown>;
  }>;
}

@Injectable()
export class JsonImporterService {
  private readonly logger = new Logger(JsonImporterService.name);
  private readonly configDir = join(__dirname, '..', '..', 'config');

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly bots:     MyBotsRepository,
    private readonly channels: TrackedChannelsConfigRepository,
    private readonly bindings: StrategyBindingsRepository,
    private readonly forwards: ForwardRoutesRepository,
  ) {}

  /** Idempotent. Reads channels.<env>.json once per env, writes once to DB. */
  async importIfNeeded(env: 'local-development' | 'dev-stage' | 'production'): Promise<{
    skipped: boolean; bots: number; channels: number; strategies: number; forwards: number;
  }> {
    const sentinel = `config_imported_${env}`;
    if (await this.hasMigration(sentinel)) {
      this.logger.debug(`Import skipped — sentinel ${sentinel} present`);
      return { skipped: true, bots: 0, channels: 0, strategies: 0, forwards: 0 };
    }

    const file = this.resolveFile(env);
    if (!file || !existsSync(file)) {
      this.logger.warn(`No JSON file found for env=${env}, skipping import`);
      await this.markMigration(sentinel);
      return { skipped: true, bots: 0, channels: 0, strategies: 0, forwards: 0 };
    }

    const raw = JSON.parse(readFileSync(file, 'utf-8')) as RawJsonConfig;

    let botsCount = 0, chCount = 0, sCount = 0, fwCount = 0;

    // 1. Bots
    for (const [botId, b] of Object.entries(raw.bots ?? {})) {
      const existing = await this.bots.findByBotId(botId);
      if (!existing) {
        await this.bots.insert({ bot_id: botId, token_env: b.tokenEnv, platform: b.platform ?? 'telegram' });
        botsCount++;
      }
    }

    // 2. Channels (need bot ids resolved)
    const channelKeyToId = new Map<string, string>();
    for (const [channelKey, ch] of Object.entries(raw.channels ?? {})) {
      const botRow = ch.botId ? await this.bots.findByBotId(ch.botId) : null;
      const isPrivate = (ch.chatId ?? channelKey).startsWith('-');
      const id = await this.channels.upsertByKey({
        channel_key: channelKey,
        username:    isPrivate ? null : channelKey.replace(/^@/, ''),
        tg_chat_id:  isPrivate ? (ch.chatId ?? channelKey) : null,
        kind:        isPrivate ? 'private' : 'public',
        bot_id:      botRow?.id ?? null,
        is_mine:     true,
      });
      channelKeyToId.set(channelKey, id);
      chCount++;
    }

    // 3. Forward routes (need both source + target resolved as channel ids)
    for (const [channelKey, ch] of Object.entries(raw.channels ?? {})) {
      const sourceId = channelKeyToId.get(channelKey);
      if (!sourceId) continue;
      for (const route of ch.forwardRoutes ?? []) {
        const targetId = channelKeyToId.get(route.channelId);
        if (!targetId) {
          this.logger.warn(`Forward route ${channelKey}→${route.channelId} skipped — target not in channels map`);
          continue;
        }
        const inserted = await this.forwards.insertIfMissing({
          source_channel_id: sourceId,
          target_channel_id: targetId,
          topic:             route.topic,
          description:       route.description,
        });
        if (inserted) fwCount++;
      }
    }

    // 4. Strategies
    for (const s of raw.strategies ?? []) {
      const channelId = channelKeyToId.get(s.channelId);
      if (!channelId) {
        this.logger.warn(`Strategy ${s.id} skipped — channel ${s.channelId} not in channels map`);
        continue;
      }
      const inserted = await this.bindings.insertIfMissing({
        ext_id:     s.id,
        type:       s.type,
        channel_id: channelId,
        schedule:   s.schedule,
        params:     s.params ?? {},
        enabled:    true,
      });
      if (inserted) sCount++;
    }

    await this.markMigration(sentinel);
    this.logger.log(
      `Imported channels.${env}.json → bots=${botsCount} channels=${chCount} strategies=${sCount} forwards=${fwCount}`,
    );

    return { skipped: false, bots: botsCount, channels: chCount, strategies: sCount, forwards: fwCount };
  }

  private resolveFile(env: string): string | null {
    if (env === 'local-development') {
      const local = join(this.configDir, 'channels.local.json');
      if (existsSync(local)) return local;
      return join(this.configDir, 'channels-dev.json');
    }
    if (env === 'dev-stage') return join(this.configDir, 'channels-dev.json');
    return join(this.configDir, 'channels.json');
  }

  private async hasMigration(version: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM schema_migrations WHERE version = $1`, [version],
    );
    return rows.length > 0;
  }

  private async markMigration(version: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING`,
      [version],
    );
  }
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm --filter automation exec tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add apps/automation/src/config/json-importer.service.ts
git commit -m "feat(config): JsonImporterService — one-shot channels.<env>.json → DB import"
```

---

## Task 7 — Config events publisher + types

**Files:**
- Create: `apps/automation/src/config/config-events.types.ts`
- Create: `apps/automation/src/config/config-events.publisher.ts`

- [ ] **Step 1: Write types**

```ts
// apps/automation/src/config/config-events.types.ts
export type ConfigChangedKind = 'bot' | 'channel' | 'strategy' | 'forward-route' | 'all';

export interface ConfigChangedEvent {
  kind: ConfigChangedKind;
  id?:  string;
  at:   string;          // ISO timestamp
}

export const CONFIG_CHANGED_CHANNEL = 'config:changed';
```

- [ ] **Step 2: Write publisher**

```ts
// apps/automation/src/config/config-events.publisher.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../tracking/redis.provider';
import { CONFIG_CHANGED_CHANNEL, ConfigChangedEvent, ConfigChangedKind } from './config-events.types';

@Injectable()
export class ConfigEventsPublisher {
  private readonly logger = new Logger(ConfigEventsPublisher.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async publish(kind: ConfigChangedKind, id?: string): Promise<void> {
    const event: ConfigChangedEvent = { kind, id, at: new Date().toISOString() };
    try {
      await this.redis.publish(CONFIG_CHANGED_CHANNEL, JSON.stringify(event));
    } catch (err: any) {
      this.logger.warn(`Failed to publish config:changed: ${err.message}`);
    }
  }
}
```

- [ ] **Step 3: Verify REDIS_CLIENT token is exported**

```bash
grep -n "REDIS_CLIENT" apps/automation/src/tracking/redis.provider.ts
```

Expect a line like `export const REDIS_CLIENT = 'REDIS_CLIENT';`. If only used internally, export it now:

```bash
# If not exported, edit redis.provider.ts to export the token symbol
```

- [ ] **Step 4: Type-check**

```bash
pnpm --filter automation exec tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/config/config-events.types.ts \
        apps/automation/src/config/config-events.publisher.ts
git commit -m "feat(config): Redis pub/sub publisher for config:changed events"
```

---

## Task 8 — ConfigCache service

**Files:**
- Create: `apps/automation/src/config/config-cache.service.ts`

- [ ] **Step 1: Write the cache**

```ts
// apps/automation/src/config/config-cache.service.ts
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../tracking/redis.provider';
import { MyBotsRepository, MyBotRow } from './my-bots.repository';
import { TrackedChannelsConfigRepository, TrackedChannelConfigRow } from './tracked-channels.repository';
import { StrategyBindingsRepository, StrategyBindingRow } from './strategy-bindings.repository';
import { ForwardRoutesRepository, ForwardRouteRow } from './forward-routes.repository';
import { CONFIG_CHANGED_CHANNEL, ConfigChangedEvent } from './config-events.types';

@Injectable()
export class ConfigCacheService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ConfigCacheService.name);

  // Maps keyed by id (UUID) AND/OR by channel_key for fast lookup.
  private botsById:        Map<string, MyBotRow> = new Map();
  private botsByBotId:     Map<string, MyBotRow> = new Map();
  private channelsById:    Map<string, TrackedChannelConfigRow> = new Map();
  private channelsByKey:   Map<string, TrackedChannelConfigRow> = new Map();
  private bindings:        StrategyBindingRow[] = [];
  private forwardRoutes:   ForwardRouteRow[] = [];

  private subscriber: Redis | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly botsRepo:     MyBotsRepository,
    private readonly channelsRepo: TrackedChannelsConfigRepository,
    private readonly bindingsRepo: StrategyBindingsRepository,
    private readonly forwardsRepo: ForwardRoutesRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.reload();
    // Subscriber must be a separate connection — duplicate the main client.
    this.subscriber = this.redis.duplicate();
    await this.subscriber.subscribe(CONFIG_CHANGED_CHANNEL);
    this.subscriber.on('message', (channel, message) => {
      if (channel !== CONFIG_CHANGED_CHANNEL) return;
      let event: ConfigChangedEvent;
      try { event = JSON.parse(message); }
      catch { return; }
      this.logger.debug(`config:changed received: ${event.kind} ${event.id ?? ''}`);
      this.scheduleReload();
    });
    this.logger.log('ConfigCacheService bootstrapped (subscribed to config:changed)');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subscriber) {
      try { await this.subscriber.quit(); } catch { /* ignore */ }
    }
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
  }

  /** Debounced — coalesces bursts of mutations into one reload. */
  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => { void this.reload(); }, 500);
  }

  async reload(): Promise<void> {
    const [bots, channels, bindings, forwards] = await Promise.all([
      this.botsRepo.list(),
      this.channelsRepo.list(),
      this.bindingsRepo.list(),
      this.forwardsRepo.list(),
    ]);
    this.botsById = new Map(bots.map(b => [b.id, b]));
    this.botsByBotId = new Map(bots.map(b => [b.bot_id, b]));
    this.channelsById = new Map(channels.map(c => [c.id, c]));
    this.channelsByKey = new Map(channels.filter(c => c.channel_key).map(c => [c.channel_key!, c]));
    this.bindings = bindings;
    this.forwardRoutes = forwards;
    this.logger.debug(
      `Cache reloaded: ${bots.length} bots, ${channels.length} channels, ${bindings.length} bindings, ${forwards.length} forward routes`,
    );
  }

  // ── Getters ─────────────────────────────────────────────────────────────

  getAllBots(): MyBotRow[] { return [...this.botsById.values()]; }
  getBotById(id: string): MyBotRow | null { return this.botsById.get(id) ?? null; }
  getBotByBotId(botId: string): MyBotRow | null { return this.botsByBotId.get(botId) ?? null; }

  getAllChannels(): TrackedChannelConfigRow[] { return [...this.channelsById.values()]; }
  getChannelById(id: string): TrackedChannelConfigRow | null { return this.channelsById.get(id) ?? null; }
  getChannelByKey(key: string): TrackedChannelConfigRow | null { return this.channelsByKey.get(key) ?? null; }

  getBindings(): StrategyBindingRow[] { return [...this.bindings]; }
  getForwardRoutes(): ForwardRouteRow[] { return [...this.forwardRoutes]; }

  /** Forward routes whose source is the given channel id. */
  getForwardRoutesForSource(sourceChannelId: string): ForwardRouteRow[] {
    return this.forwardRoutes.filter(r => r.source_channel_id === sourceChannelId);
  }
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm --filter automation exec tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add apps/automation/src/config/config-cache.service.ts
git commit -m "feat(config): ConfigCacheService — in-memory cache + Redis pub/sub reload"
```

---

## Task 9 — Refactor ChannelConfigService

**Files:**
- Modify: `apps/automation/src/config/channel-config.service.ts`

The current service reads JSON. We rewrite the internals while keeping the
public API. After this task: the existing scheduler / strategies / publisher
all keep working without changes.

- [ ] **Step 1: Read current public API**

```bash
grep -n "^\s*\(resolveChannel\|resolveStrategyBindings\|getForwardRoutes\|listChannels\|pickBot\)" apps/automation/src/config/channel-config.service.ts
```

Note the method signatures returned — keep them stable.

- [ ] **Step 2: Replace the implementation**

Replace the file content with the refactored version. The full new content:

```ts
// apps/automation/src/config/channel-config.service.ts
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigCacheService } from './config-cache.service';
import { JsonImporterService } from './json-importer.service';

export type AppEnv = 'local-development' | 'dev-stage' | 'production';
const VALID_ENVS: AppEnv[] = ['local-development', 'dev-stage', 'production'];
const isAppEnv = (v: unknown): v is AppEnv =>
  typeof v === 'string' && (VALID_ENVS as string[]).includes(v);

export interface ResolvedChannel {
  platform:  string;
  chatId:    string;        // either '@username' or '-100…' or numeric string
  botToken:  string;        // resolved from env
  botId:     string;        // logical bot_id (matches what JSON used)
}

export interface ResolvedStrategyBinding {
  id:         string;
  type:       string;
  channelId:  string;       // channel_key for back-compat with strategies
  schedule:   string;
  params:     Record<string, unknown>;
  enabled:    boolean;
}

export interface ForwardRoute {
  topic:       string;
  channelId:   string;      // target channel_key
  description: string;
}

@Injectable()
export class ChannelConfigService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ChannelConfigService.name);

  // Tunable via env. 8h matches what the multi-env design uses.
  private static readonly DEFAULT_SEMANTIC_DEDUP_HOURS = 8;

  constructor(
    private readonly env:      ConfigService,
    private readonly cache:    ConfigCacheService,
    private readonly importer: JsonImporterService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const nodeEnv = process.env.NODE_ENV;
    if (!isAppEnv(nodeEnv)) {
      const got = nodeEnv === undefined ? 'unset' : `"${nodeEnv}"`;
      throw new Error(
        `NODE_ENV is ${got}. Must be one of: ${VALID_ENVS.join(', ')}. ` +
        `Set it in .env (laptop: local-development, dev-stage server: dev-stage, prod server: production).`,
      );
    }

    // One-shot importer — idempotent.
    const stats = await this.importer.importIfNeeded(nodeEnv);
    if (!stats.skipped) {
      // Force cache rebuild after importer changed rows.
      await this.cache.reload();
    }

    const bots = this.cache.getAllBots();
    const channels = this.cache.getAllChannels();
    const bindings = this.cache.getBindings();
    this.logger.log(
      `Config: source=DB (NODE_ENV=${nodeEnv}) | ${bots.length} bot(s), ${channels.length} channel(s), ${bindings.length} strategy(ies)`,
    );
  }

  // ── Public API (unchanged signatures) ─────────────────────────────────

  resolveChannel(channelKey: string): ResolvedChannel {
    const ch = this.cache.getChannelByKey(channelKey)
            ?? this.cache.getChannelById(channelKey);
    if (!ch) throw new Error(`Channel "${channelKey}" not found in config`);

    const bot = ch.bot_id ? this.cache.getBotById(ch.bot_id) : null;
    if (!bot) throw new Error(`Channel "${channelKey}" has no bot bound`);

    const token = this.env.get<string>(bot.token_env);
    if (!token) {
      throw new Error(`Env var "${bot.token_env}" is not set (bot: ${bot.bot_id})`);
    }

    const chatId = ch.kind === 'private'
      ? (ch.tg_chat_id ?? channelKey)
      : (ch.channel_key ?? channelKey);

    return {
      platform: 'telegram',
      chatId,
      botToken: token,
      botId:    bot.bot_id,
    };
  }

  resolveStrategyBindings(): ResolvedStrategyBinding[] {
    return this.cache.getBindings().map(b => {
      const ch = this.cache.getChannelById(b.channel_id);
      return {
        id:        b.ext_id,
        type:      b.type,
        channelId: ch?.channel_key ?? b.channel_id,
        schedule:  b.schedule,
        params:    b.params,
        enabled:   b.enabled,
      };
    });
  }

  getForwardRoutes(channelKey: string): ForwardRoute[] {
    const ch = this.cache.getChannelByKey(channelKey);
    if (!ch) return [];
    const routes = this.cache.getForwardRoutesForSource(ch.id);
    return routes.map(r => {
      const target = this.cache.getChannelById(r.target_channel_id);
      return {
        topic:       r.topic,
        channelId:   target?.channel_key ?? r.target_channel_id,
        description: r.description,
      };
    });
  }

  listChannels(): string[] {
    return this.cache.getAllChannels()
      .map(c => c.channel_key)
      .filter((k): k is string => !!k);
  }

  /** Used by SemanticDedupService — env-tunable, falls back to 8h. */
  getSemanticDedupHours(): number {
    const v = this.env.get<string>('SEMANTIC_DEDUP_HOURS');
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : ChannelConfigService.DEFAULT_SEMANTIC_DEDUP_HOURS;
  }
}
```

- [ ] **Step 3: Type-check**

```bash
pnpm --filter automation exec tsc --noEmit
```

If errors mention `listChannels` or `pickBot` not matching the old API:
- `listChannels` — verify the existing callers use the same shape (array of strings)
- `pickBot` was internal; check that nothing imports it. If something does, restore it as a wrapper around `cache.getBotById`.

- [ ] **Step 4: Commit**

```bash
git add apps/automation/src/config/channel-config.service.ts
git commit -m "refactor(config): ChannelConfigService reads from DB cache (JSON via one-shot importer)"
```

---

## Task 10 — Update ConfigModule wiring

**Files:**
- Modify: `apps/automation/src/config/config.module.ts`

- [ ] **Step 1: Inspect current module**

```bash
cat apps/automation/src/config/config.module.ts
```

- [ ] **Step 2: Add new providers**

Replace the content with (preserving any custom exports the existing module has — adjust if more is exported):

```ts
// apps/automation/src/config/config.module.ts
import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module';
import { TrackingModule } from '../tracking/tracking.module';   // for REDIS_CLIENT provider
import { ChannelConfigService } from './channel-config.service';
import { ConfigCacheService } from './config-cache.service';
import { ConfigEventsPublisher } from './config-events.publisher';
import { JsonImporterService } from './json-importer.service';
import { MyBotsRepository } from './my-bots.repository';
import { TrackedChannelsConfigRepository } from './tracked-channels.repository';
import { StrategyBindingsRepository } from './strategy-bindings.repository';
import { ForwardRoutesRepository } from './forward-routes.repository';
import { TelegramGetMeClient } from './telegram-getme.client';
import { MyBotsController } from './api/my-bots.controller';
import { AuthModule } from '../auth/auth.module';

@Global()
@Module({
  imports: [NestConfigModule, DatabaseModule, TrackingModule, AuthModule],
  controllers: [MyBotsController],
  providers: [
    ChannelConfigService,
    ConfigCacheService,
    ConfigEventsPublisher,
    JsonImporterService,
    MyBotsRepository,
    TrackedChannelsConfigRepository,
    StrategyBindingsRepository,
    ForwardRoutesRepository,
    TelegramGetMeClient,
  ],
  exports: [
    ChannelConfigService,
    ConfigCacheService,
    ConfigEventsPublisher,
    MyBotsRepository,
    TrackedChannelsConfigRepository,
    StrategyBindingsRepository,
    ForwardRoutesRepository,
  ],
})
export class ChannelConfigModule {}
```

(Module name `ChannelConfigModule` matches existing — keep it; AppModule imports under that name.)

- [ ] **Step 3: Type-check + build**

```bash
pnpm --filter automation exec tsc --noEmit
pnpm --filter automation run build
```

- [ ] **Step 4: Commit**

```bash
git add apps/automation/src/config/config.module.ts
git commit -m "feat(config): register all new providers + controller in ChannelConfigModule"
```

---

## Task 11 — My bots DTOs + controller

**Files:**
- Create: `apps/automation/src/config/api/dto/my-bots.dto.ts`
- Create: `apps/automation/src/config/api/my-bots.controller.ts`

- [ ] **Step 1: DTOs**

```ts
// apps/automation/src/config/api/dto/my-bots.dto.ts
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateBotDto {
  @IsString()
  @Matches(/^[a-z0-9_]+$/i, { message: 'bot_id must be alphanumeric + underscore' })
  @MaxLength(64)
  bot_id!: string;

  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]*$/, { message: 'token_env must be UPPER_SNAKE_CASE' })
  @MaxLength(64)
  token_env!: string;
}

export class PatchBotDto {
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
```

- [ ] **Step 2: Controller**

```ts
// apps/automation/src/config/api/my-bots.controller.ts
import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get,
  HttpCode, NotFoundException, Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { MyBotsRepository } from '../my-bots.repository';
import { TelegramGetMeClient } from '../telegram-getme.client';
import { ConfigEventsPublisher } from '../config-events.publisher';
import { CreateBotDto, PatchBotDto } from './dto/my-bots.dto';

@Controller('api/my-bots')
@UseGuards(TrackingAuthGuard)
export class MyBotsController {
  constructor(
    private readonly bots:       MyBotsRepository,
    private readonly tgGetMe:    TelegramGetMeClient,
    private readonly env:        ConfigService,
    private readonly publisher:  ConfigEventsPublisher,
  ) {}

  @Get()
  async list() {
    const rows = await this.bots.list();
    return rows.map(r => ({
      id: r.id, bot_id: r.bot_id, username: r.username, first_name: r.first_name,
      platform: r.platform, token_env: r.token_env, active: r.active,
      last_verified_at: r.last_verified_at, verify_error: r.verify_error,
      created_at: r.created_at,
    }));
  }

  @Post()
  async create(@Body() body: CreateBotDto) {
    const existing = await this.bots.findByBotId(body.bot_id);
    if (existing) throw new ConflictException(`bot_id ${body.bot_id} already exists`);
    const row = await this.bots.insert(body);
    await this.publisher.publish('bot', row.id);
    return row;
  }

  @Post(':id/verify')
  async verify(@Param('id') id: string) {
    const bot = await this.bots.findById(id);
    if (!bot) throw new NotFoundException(`Bot ${id} not found`);

    const token = this.env.get<string>(bot.token_env);
    if (!token) {
      await this.bots.markVerifyError(id, `Env var ${bot.token_env} is not set`);
      throw new BadRequestException(`Env var ${bot.token_env} is not set`);
    }

    try {
      const me = await this.tgGetMe.getMe(token);
      await this.bots.markVerified(id, { username: me.username, first_name: me.first_name });
      await this.publisher.publish('bot', id);
      return { ok: true, username: me.username, first_name: me.first_name };
    } catch (err: any) {
      await this.bots.markVerifyError(id, err.message);
      await this.publisher.publish('bot', id);
      return { ok: false, error: err.message };
    }
  }

  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: PatchBotDto) {
    const bot = await this.bots.findById(id);
    if (!bot) throw new NotFoundException(`Bot ${id} not found`);
    if (typeof body.active === 'boolean') {
      await this.bots.setActive(id, body.active);
    }
    await this.publisher.publish('bot', id);
    return { ok: true };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string) {
    const bound = await this.bots.countChannelsBound(id);
    if (bound > 0) {
      throw new ConflictException(`Bot still bound to ${bound} channel(s) — reassign first`);
    }
    const ok = await this.bots.delete(id);
    if (!ok) throw new NotFoundException(`Bot ${id} not found`);
    await this.publisher.publish('bot', id);
  }
}
```

- [ ] **Step 3: Type-check + build**

```bash
pnpm --filter automation exec tsc --noEmit
pnpm --filter automation run build
```

- [ ] **Step 4: Boot the app to verify wiring**

```bash
# Make sure redis + postgres are running
docker compose up -d postgres redis

# Strategies stripped already from channels.local.json (cost-safe)
pnpm dev:automation
# Expect log lines:
#   [ConfigCacheService] info: ConfigCacheService bootstrapped (subscribed to config:changed)
#   [ChannelConfigService] info: Config: source=DB (NODE_ENV=local-development) | N bot(s), N channel(s), 0 strategy(ies)
#   [RouterExplorer] info: Mapped {/api/my-bots, GET}
# Stop with Ctrl-C after verifying.
```

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/config/api/dto/my-bots.dto.ts \
        apps/automation/src/config/api/my-bots.controller.ts
git commit -m "feat(config): MyBotsController — list / create / verify / patch / delete"
```

---

## Task 12 — Backend smoke test

Manual verification. No commit.

- [ ] **Step 1: Confirm importer ran**

```bash
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c "
  SELECT version FROM schema_migrations WHERE version LIKE 'config_imported_%';"
```

Expect: a row for the env you booted with (e.g. `config_imported_local-development`).

- [ ] **Step 2: Check bot rows**

```bash
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c "
  SELECT bot_id, token_env, active, last_verified_at FROM my_bots;"
```

Expect: at least one bot (`ai0_global_test_bot` or similar from the JSON).

- [ ] **Step 3: Hit the REST endpoints**

```bash
curl -s http://localhost:3000/api/my-bots | python3 -m json.tool

# Get the first bot id
BOT_ID=$(curl -s http://localhost:3000/api/my-bots | python3 -c 'import sys,json; print(json.load(sys.stdin)[0]["id"])')
echo "Bot id: $BOT_ID"

# Verify (calls getMe)
curl -s -X POST "http://localhost:3000/api/my-bots/$BOT_ID/verify" | python3 -m json.tool

# Re-read
curl -s http://localhost:3000/api/my-bots | python3 -m json.tool
```

Expect: `verify` returns `{ ok: true, username, first_name }`; second list call shows the same fields populated.

If `ok: false` with `Env var TELEGRAM_BOT_TOKEN is not set` — set it in `.env` and re-verify.

---

## Task 13 — Sidebar component

**Files:**
- Create: `apps/dashboard/src/components/Sidebar.tsx`

- [ ] **Step 1: Write the component**

```tsx
// apps/dashboard/src/components/Sidebar.tsx
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

interface NavItem {
  to:     string;
  label:  string;
  icon:   string;        // emoji or text glyph — keeps zero icon-lib weight
  hint?:  string;
}

const ITEMS: NavItem[] = [
  { to: '/channels',        label: 'Channels',        icon: '🛰' },
  { to: '/discovery',       label: 'Discovery',       icon: '🔎' },
  { to: '/graph',           label: 'Graph',           icon: '🕸' },
  { to: '/recommendations', label: 'Recommendations', icon: '🎯' },
  { to: '/bots',            label: 'Bots',            icon: '🤖' },
  // Placeholders for 5c (disabled in 5a)
  { to: '/strategies',      label: 'Strategies',      icon: '⏱', hint: 'Phase 5c' },
];

const COLLAPSED_KEY = 'dashboard:sidebar-collapsed';

export function Sidebar() {
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem(COLLAPSED_KEY) === '1',
  );

  const toggle = () => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };

  const width = collapsed ? 64 : 220;

  return (
    <aside
      style={{
        width,
        borderRight: '1px solid var(--color-hairline)',
        background: 'var(--color-canvas)',
        height: '100vh',
        position: 'sticky',
        top: 0,
        display: 'flex',
        flexDirection: 'column',
        transition: 'width 150ms ease',
      }}
    >
      <nav
        style={{ display: 'flex', flexDirection: 'column', padding: '12px 8px', gap: 4, flex: 1 }}
      >
        {ITEMS.map(item => {
          const isDisabled = !!item.hint;
          const content = (
            <span style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '8px 10px', borderRadius: 6,
              color: 'var(--color-ink-muted)',
              opacity: isDisabled ? 0.4 : 1,
              fontSize: 14,
            }}>
              <span style={{ width: 18, textAlign: 'center' }}>{item.icon}</span>
              {!collapsed && <span>{item.label}</span>}
              {!collapsed && item.hint && (
                <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.6 }}>{item.hint}</span>
              )}
            </span>
          );
          if (isDisabled) {
            return (
              <div key={item.to} title={item.hint} style={{ cursor: 'not-allowed' }}>
                {content}
              </div>
            );
          }
          return (
            <Link
              key={item.to}
              to={item.to as any}
              className="transition-colors hover:text-white"
              activeProps={{ style: { color: 'var(--color-ink)', background: 'var(--color-hairline)' } }}
              style={{ textDecoration: 'none' }}
            >
              {content}
            </Link>
          );
        })}
      </nav>
      <button
        onClick={toggle}
        style={{
          margin: '8px 10px', padding: '8px 10px', borderRadius: 6,
          background: 'transparent', border: '1px solid var(--color-hairline)',
          color: 'var(--color-ink-muted)', cursor: 'pointer', fontSize: 12,
        }}
        title={collapsed ? 'Expand' : 'Collapse'}
      >
        {collapsed ? '›' : '‹ Collapse'}
      </button>
    </aside>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm --filter dashboard exec tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/Sidebar.tsx
git commit -m "feat(dashboard): Sidebar component (collapsible, emoji-icons, route-aware)"
```

---

## Task 14 — Layout refactor (sidebar in)

**Files:**
- Modify: `apps/dashboard/src/components/Layout.tsx`

- [ ] **Step 1: Replace Layout content**

```tsx
// apps/dashboard/src/components/Layout.tsx
import { Link, Outlet } from '@tanstack/react-router';
import { useAuth } from '../auth/use-auth';
import { authApi } from '../api/auth';
import { Sidebar } from './Sidebar';

export function Layout() {
  const { me, refresh } = useAuth();
  const onLogout = async () => {
    await authApi.logout();
    await refresh();
    window.location.href = '/login';
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--color-canvas)' }}>
      <Sidebar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <header
          style={{
            borderBottom: '1px solid var(--color-hairline)',
            background: 'var(--color-canvas)',
          }}
        >
          <div
            style={{
              height: 56,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 24px',
            }}
          >
            <Link
              to={'/channels' as any}
              style={{ color: 'var(--color-ink)', textDecoration: 'none' }}
              className="text-headline"
            >
              Channel Tracker
            </Link>
            {me && (
              <div className="flex items-center gap-3 text-sm">
                <span style={{ color: 'var(--color-ink-muted)' }}>
                  {me.firstName}{me.username ? ` (@${me.username})` : ''}
                </span>
                <button onClick={onLogout} className="btn-secondary">Logout</button>
              </div>
            )}
          </div>
        </header>
        <main style={{ flex: 1, padding: '40px 24px', maxWidth: 1400, margin: '0 auto', width: '100%' }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check + build**

```bash
pnpm --filter dashboard exec tsc --noEmit
pnpm --filter dashboard run build
```

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/Layout.tsx
git commit -m "feat(dashboard): Layout uses Sidebar; header trimmed to title + user identity"
```

---

## Task 15 — Frontend bot types + API

**Files:**
- Modify: `apps/dashboard/src/api/types.ts`
- Create: `apps/dashboard/src/api/bots.ts`

- [ ] **Step 1: Add `Bot` type**

Append to `apps/dashboard/src/api/types.ts`:

```ts
// At bottom of types.ts

export interface Bot {
  id:               string;
  bot_id:           string;
  username:         string | null;
  first_name:       string | null;
  platform:         string;
  token_env:        string;
  active:           boolean;
  last_verified_at: string | null;
  verify_error:     string | null;
  created_at:       string;
}
```

- [ ] **Step 2: Write the hooks**

```ts
// apps/dashboard/src/api/bots.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { Bot } from './types';

export function useBots() {
  return useQuery({
    queryKey: ['bots'],
    queryFn:  () => api<Bot[]>('/api/my-bots'),
  });
}

export function useCreateBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { bot_id: string; token_env: string }) =>
      api<Bot>('/api/my-bots', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bots'] }),
  });
}

export function useVerifyBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; username?: string; first_name?: string; error?: string }>(
        `/api/my-bots/${id}/verify`,
        { method: 'POST' },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bots'] }),
  });
}

export function useToggleBotActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api<{ ok: boolean }>(`/api/my-bots/${id}`, {
        method: 'PATCH', body: JSON.stringify({ active }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bots'] }),
  });
}

export function useDeleteBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/my-bots/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bots'] }),
  });
}
```

- [ ] **Step 3: Type-check**

```bash
pnpm --filter dashboard exec tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/api/types.ts apps/dashboard/src/api/bots.ts
git commit -m "feat(dashboard): bot type + react-query hooks"
```

---

## Task 16 — AddBotModal

**Files:**
- Create: `apps/dashboard/src/components/AddBotModal.tsx`

- [ ] **Step 1: Write the modal**

```tsx
// apps/dashboard/src/components/AddBotModal.tsx
import { useState } from 'react';
import { useCreateBot } from '../api/bots';

interface Props {
  open:    boolean;
  onClose: () => void;
}

export function AddBotModal({ open, onClose }: Props) {
  const [botId, setBotId]       = useState('');
  const [tokenEnv, setTokenEnv] = useState('TELEGRAM_BOT_TOKEN');
  const create = useCreateBot();

  if (!open) return null;

  const submit = async () => {
    try {
      await create.mutateAsync({ bot_id: botId.trim(), token_env: tokenEnv.trim() });
      setBotId('');
      setTokenEnv('TELEGRAM_BOT_TOKEN');
      onClose();
    } catch {
      // Error shown via create.error below; modal stays open.
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.72)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 480,
          background: 'var(--color-canvas)',
          border: '1px solid var(--color-hairline)',
          borderRadius: 12, padding: 24,
        }}
      >
        <h2 style={{ margin: 0, marginBottom: 16, color: 'var(--color-ink)', fontSize: 18 }}>
          Add bot
        </h2>

        <label style={{ display: 'block', marginBottom: 12 }}>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--color-ink-muted)', marginBottom: 4 }}>
            Bot id (logical name)
          </span>
          <input
            value={botId}
            onChange={e => setBotId(e.target.value)}
            placeholder="ai0_partners_bot"
            className="input-field w-full"
          />
        </label>

        <label style={{ display: 'block', marginBottom: 12 }}>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--color-ink-muted)', marginBottom: 4 }}>
            Token env-var name
          </span>
          <input
            value={tokenEnv}
            onChange={e => setTokenEnv(e.target.value)}
            placeholder="TELEGRAM_BOT_TOKEN_2"
            className="input-field w-full"
          />
        </label>

        <p style={{ fontSize: 12, color: 'var(--color-ink-muted)', marginTop: 4, marginBottom: 16 }}>
          After saving, put the actual token into your <code>.env</code> as <code>{tokenEnv || 'TELEGRAM_BOT_TOKEN'}=...</code> and restart automation. Then click <b>Verify</b> on the row.
        </p>

        {create.error && (
          <p style={{ color: 'var(--color-danger)', fontSize: 13, marginBottom: 12 }}>
            {(create.error as Error).message}
          </p>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button
            onClick={submit}
            disabled={!botId || !tokenEnv || create.isPending}
            className="btn-primary"
          >
            {create.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm --filter dashboard exec tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/AddBotModal.tsx
git commit -m "feat(dashboard): AddBotModal — bot_id + token_env input"
```

---

## Task 17 — /bots route

**Files:**
- Create: `apps/dashboard/src/routes/bots.tsx`

- [ ] **Step 1: Write the route**

```tsx
// apps/dashboard/src/routes/bots.tsx
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { AddBotModal } from '../components/AddBotModal';
import {
  useBots, useDeleteBot, useToggleBotActive, useVerifyBot,
} from '../api/bots';

export const Route = createFileRoute('/bots')({ component: BotsPage });

function BotsPage() {
  const { data, isLoading, error } = useBots();
  const verify  = useVerifyBot();
  const toggle  = useToggleBotActive();
  const remove  = useDeleteBot();
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 className="text-display-md" style={{ margin: 0 }}>Bots</h1>
        <button onClick={() => setAddOpen(true)} className="btn-primary">+ Add bot</button>
      </header>

      {isLoading && <p style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
      {error && <p style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>}

      {data && data.length === 0 && (
        <p style={{ color: 'var(--color-ink-muted)' }}>No bots configured yet.</p>
      )}

      {data && data.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-2">Bot id</th>
                <th className="px-3 py-2">Username</th>
                <th className="px-3 py-2">Token env</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Last verified</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.map(b => (
                <tr key={b.id} className="border-t hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono text-xs">{b.bot_id}</td>
                  <td className="px-3 py-2">{b.username ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs">{b.token_env}</td>
                  <td className="px-3 py-2">
                    {b.verify_error
                      ? <span title={b.verify_error} style={{ color: 'var(--color-danger)' }}>⚠ {b.verify_error.slice(0, 40)}</span>
                      : b.username
                        ? <span style={{ color: 'var(--color-success, #16a34a)' }}>✓ verified</span>
                        : <span style={{ color: 'var(--color-ink-muted)' }}>unverified</span>}
                    {!b.active && <span style={{ marginLeft: 8, color: 'var(--color-ink-muted)' }}>(inactive)</span>}
                  </td>
                  <td className="px-3 py-2 text-xs" style={{ color: 'var(--color-ink-muted)' }}>
                    {b.last_verified_at ? new Date(b.last_verified_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <button onClick={() => verify.mutate(b.id)} className="text-sm text-blue-600 hover:underline mr-3">
                      Verify
                    </button>
                    <button
                      onClick={() => toggle.mutate({ id: b.id, active: !b.active })}
                      className="text-sm text-blue-600 hover:underline mr-3"
                    >
                      {b.active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Delete bot ${b.bot_id}?`)) remove.mutate(b.id);
                      }}
                      className="text-sm text-red-600 hover:underline"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AddBotModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
```

- [ ] **Step 2: Regenerate route tree**

```bash
cd apps/dashboard
pnpm dev > /tmp/vite-bots.log 2>&1 &
DEV_PID=$!
sleep 4
kill $DEV_PID 2>/dev/null
wait $DEV_PID 2>/dev/null
cd ../..
grep -c "/bots" apps/dashboard/src/routeTree.gen.ts
```

Expect: number > 0 (route entry added).

- [ ] **Step 3: Type-check + build**

```bash
pnpm --filter dashboard exec tsc --noEmit
pnpm --filter dashboard run build
```

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/routes/bots.tsx apps/dashboard/src/routeTree.gen.ts
git commit -m "feat(dashboard): /bots page with verify/toggle/delete + Add modal"
```

---

## Task 18 — End-to-end smoke

Manual. No commit. Run with cost-safe `channels.local.json` (strategies still `[]`).

- [ ] **Step 1: Boot the stack**

Terminal 1 (postgres + redis):
```bash
docker compose up -d postgres redis
```

Terminal 2 (automation):
```bash
pnpm dev:automation
```

Verify the boot log shows:
```
[ConfigCacheService] info: ConfigCacheService bootstrapped (subscribed to config:changed)
[ChannelConfigService] info: Config: source=DB (NODE_ENV=local-development) | N bot(s), N channel(s), 0 strategy(ies)
[RouterExplorer] info: Mapped {/api/my-bots, GET} route
```

Terminal 3 (dashboard):
```bash
pnpm --filter dashboard run dev
```

- [ ] **Step 2: Browser**

1. Open http://localhost:5173 (dev-bypass → no login)
2. Sidebar visible on left — Channels, Discovery, Graph, Recommendations, Bots, Strategies (greyed)
3. Click **Bots** — table shows the imported bot(s)
4. Click **Verify** on the existing bot — expect ✓ verified, username populated
5. Click **+ Add bot** — modal opens
6. Fill: bot_id = `fake_test_bot`, token_env = `BOGUS_TOKEN` → Save
7. New row appears, "unverified"
8. Click Verify — expect ⚠ with "Env var BOGUS_TOKEN is not set"
9. Click Delete — row disappears

- [ ] **Step 3: Verify Redis pub/sub fired**

In a fourth terminal:
```bash
docker exec ai0_global-redis-1 redis-cli SUBSCRIBE 'config:changed'
```

Then in the dashboard, click any mutation (Verify / Toggle / Delete) — the subscriber should print a JSON event line.

---

## Task 19 — Push

- [ ] **Step 1: Verify all commits**

```bash
git log --oneline feat/graph-and-roi..HEAD | head -25
```

Expect: ~18 commits + spec + plan = ~20 commits ahead of `feat/graph-and-roi`.

- [ ] **Step 2: Push**

```bash
git push -u origin feat/config-in-db
```

---

## Self-review

**Spec coverage:**
- Sidebar refactor → Task 13 + 14 ✓
- DB migration → Task 1 ✓
- `my_bots` repo → Task 2 ✓
- `tracked_channels` extension + repo → Task 1 (columns) + Task 3 (repo) ✓
- `strategy_bindings` + `forward_routes` repos → Task 4 ✓
- Telegram getMe client → Task 5 ✓
- JSON importer service → Task 6 ✓
- Redis pub/sub + types → Task 7 ✓
- ConfigCacheService → Task 8 ✓
- ChannelConfigService rewrite (same API) → Task 9 ✓
- Module wiring → Task 10 ✓
- Bots DTO + controller → Task 11 ✓
- Frontend types + hooks → Task 15 ✓
- AddBotModal → Task 16 ✓
- `/bots` route → Task 17 ✓
- Backend smoke → Task 12 ✓
- E2E smoke → Task 18 ✓
- Push → Task 19 ✓

**Placeholder scan:** no `TBD`, no `TODO`, no "Add appropriate error handling" — every code block is complete.

**Type consistency:**
- `MyBotRow` (Task 2) — same fields used in Task 8 cache, Task 11 controller, Task 15 frontend Bot type. ✓
- `TrackedChannelConfigRow` (Task 3) — used by Task 8 cache + Task 9 ChannelConfigService. ✓
- `StrategyBindingRow.params` is `Record<string, unknown>` in Task 4 and Task 9 — matches. ✓
- Importer (Task 6) takes a single env arg; ChannelConfigService (Task 9) passes the validated env. ✓
- `CONFIG_CHANGED_CHANNEL` constant defined once in Task 7, imported by Task 8. ✓
- `REDIS_CLIENT` token — referenced from `tracking/redis.provider.ts`; Task 7 step 3 verifies the export. ✓

**Open assumption:** `REDIS_CLIENT` may need to be re-exported if it's currently only used internally by TrackingModule. Task 7 step 3 catches this. If it isn't exported, add `export` to the relevant line in `redis.provider.ts` and commit alongside Task 7.

---

## Cost-safety reminder

Throughout 5a, keep `channels.local.json`'s `strategies` array empty. No
Claude calls, no Telegram posts. The only network call is the free
`api.telegram.org/bot<token>/getMe` for bot verification.
