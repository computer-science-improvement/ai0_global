# Tracking Backend (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track 500+ arbitrary Telegram channels via MTProto, capture posts and metric snapshots, extract ad-link edges, and expose everything via a REST API. Backend-only — no UI.

**Architecture:** A cron-driven `TrackingScheduler` enqueues jobs into BullMQ (Redis). Worker processes call MTProto via a `TrackingMtprotoClient` (extends existing `TelegramStatsClient`), pass results through pure processors (`postExtractor`, `adRefExtractor`, `tierClassifier`, `roiHeuristic`), and persist via three Postgres repositories. A NestJS REST controller serves channel lists, post lists, sub-history, graph data, and a heuristic ROI estimate.

**Tech Stack:** NestJS 10, TypeScript, gramjs (MTProto), BullMQ + ioredis (queues), node-postgres `pg.Pool`, Node's built-in `node:test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-05-13-channel-tracking-platform-design.md`

**Branch:** `feat/tracking-backend`

---

## File structure

### New files

```
database/migrations/
└── 002_tracking.sql                           -- 5 tables + indexes

apps/automation/src/tracking/
├── tracking.module.ts                          -- @Module wiring
├── tracking.tokens.ts                          -- REDIS injection symbol
├── redis.provider.ts                           -- ioredis factory provider
├── tracking-queue.service.ts                   -- BullMQ Queue wrapper
├── tracking.scheduler.ts                       -- @Cron tier-aware enqueue
├── processors/
│   ├── tier-classifier.ts                      -- pure: posts → tier
│   ├── tier-classifier.test.ts
│   ├── ad-ref-extractor.ts                     -- pure: msg → AdRef[]
│   ├── ad-ref-extractor.test.ts
│   ├── roi-heuristic.ts                        -- pure: stats → ROI
│   └── roi-heuristic.test.ts
├── repositories/
│   ├── tracked-channels.repository.ts          -- CRUD + upsert
│   ├── tracked-posts.repository.ts             -- upsert + queries
│   └── tracked-edges.repository.ts             -- upsert (increment)
├── mtproto/
│   └── tracking-mtproto.client.ts              -- GetHistory, ResolveUsername
├── workers/
│   ├── poll-meta.worker.ts                     -- GetFullChannel → repo
│   ├── poll-posts.worker.ts                    -- GetHistory → extract → repos
│   ├── refresh-metrics.worker.ts               -- recent posts → metric snapshot
│   └── resolve-discovery.worker.ts             -- ResolveUsername → enqueue/skip
├── api/
│   ├── tracking.controller.ts                  -- REST routes
│   ├── tracking.service.ts                     -- query layer
│   ├── tracking-auth.guard.ts                  -- Bearer-token stub
│   └── dto/
│       ├── add-channel.dto.ts
│       ├── tracked-channel.dto.ts
│       ├── tracked-post.dto.ts
│       └── graph.dto.ts
└── types.ts                                    -- AdRef, PollJobData, etc.
```

### Modified files

- `apps/automation/src/app.module.ts` — register `TrackingModule`
- `apps/automation/package.json` — add `bullmq`, `ioredis`
- `apps/automation/.env.example` — new vars
- `docker-compose.yml` — add `redis` service

---

## Task 1: Add Redis to docker-compose + dependencies

**Files:**
- Modify: `docker-compose.yml`
- Modify: `apps/automation/package.json`
- Modify: `apps/automation/.env.example`

- [ ] **Step 1: Add redis service to `docker-compose.yml`** (under `services:`, alongside `postgres`)

```yaml
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    ports:
      - "${REDIS_PORT:-6379}:6379"
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
```

And add `redisdata:` to the bottom `volumes:` block.

- [ ] **Step 2: Wire `automation` service to depend on redis** — under `automation:` service, add `redis` to `depends_on`:

```yaml
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
```

Add `REDIS_URL: redis://redis:6379` to `automation.environment`.

- [ ] **Step 3: Install BullMQ + ioredis**

```bash
pnpm --filter automation add bullmq ioredis
```

Expected: `package.json` shows `"bullmq": "^5.x"` and `"ioredis": "^5.x"`.

- [ ] **Step 4: Document new env vars in `.env.example`**

Append:

```
# Tracking module (Phase 1)
REDIS_URL=redis://localhost:6379
TRACKING_ENABLED=true
TRACKING_POLL_INTERVAL_HOT_MIN=5
TRACKING_POLL_INTERVAL_WARM_MIN=30
TRACKING_POLL_INTERVAL_COLD_HOURS=6
TRACKING_VIEW_TO_SUB_RATE=0.02
TRACKING_TOKEN=changeme-bearer-token
```

- [ ] **Step 5: Start Redis locally to confirm**

```bash
docker compose up -d redis
docker compose ps redis
```

Expected: redis container shown as `(healthy)`.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml apps/automation/package.json apps/automation/pnpm-lock.yaml pnpm-lock.yaml apps/automation/.env.example
git commit -m "build(tracking): add Redis service and BullMQ deps"
```

---

## Task 2: Migration `002_tracking.sql`

**Files:**
- Create: `database/migrations/002_tracking.sql`

- [ ] **Step 1: Write the SQL migration**

Create `database/migrations/002_tracking.sql` with the exact tables from the spec:

```sql
-- 002_tracking.sql
-- Channel-tracking platform (Phase 1): channels under monitoring + per-post
-- snapshots + ad-link edges between channels.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tracked_channels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tg_chat_id      BIGINT UNIQUE,
  username        TEXT,
  title           TEXT,
  about           TEXT,
  category        TEXT,
  is_mine         BOOLEAN NOT NULL DEFAULT FALSE,
  is_closed       BOOLEAN NOT NULL DEFAULT FALSE,
  poll_tier       TEXT NOT NULL DEFAULT 'warm',
  subs_count      INT,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_polled_at  TIMESTAMPTZ,
  meta            JSONB
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tracked_channels_username
  ON tracked_channels (LOWER(username)) WHERE username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracked_channels_tier_polled
  ON tracked_channels (poll_tier, last_polled_at);
CREATE INDEX IF NOT EXISTS idx_tracked_channels_is_mine
  ON tracked_channels (is_mine);

CREATE TABLE IF NOT EXISTS tracked_subs_history (
  channel_id   UUID NOT NULL REFERENCES tracked_channels(id) ON DELETE CASCADE,
  snapshot_at  TIMESTAMPTZ NOT NULL,
  subs_count   INT NOT NULL,
  PRIMARY KEY (channel_id, snapshot_at)
);

CREATE TABLE IF NOT EXISTS tracked_posts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id       UUID NOT NULL REFERENCES tracked_channels(id) ON DELETE CASCADE,
  tg_message_id    BIGINT NOT NULL,
  text             TEXT,
  has_media        BOOLEAN NOT NULL DEFAULT FALSE,
  media_type       TEXT,
  posted_at        TIMESTAMPTZ NOT NULL,
  views            INT,
  forwards         INT,
  reactions_total  INT,
  reactions        JSONB,
  comments_count   INT,
  ad_refs          JSONB,
  last_metrics_at  TIMESTAMPTZ,
  UNIQUE (channel_id, tg_message_id)
);
CREATE INDEX IF NOT EXISTS idx_tracked_posts_channel_posted
  ON tracked_posts (channel_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracked_posts_ad_refs
  ON tracked_posts USING GIN (ad_refs)
  WHERE ad_refs IS NOT NULL;

CREATE TABLE IF NOT EXISTS tracked_post_metrics_history (
  post_id      UUID NOT NULL REFERENCES tracked_posts(id) ON DELETE CASCADE,
  snapshot_at  TIMESTAMPTZ NOT NULL,
  views        INT NOT NULL,
  forwards     INT NOT NULL,
  reactions    INT NOT NULL,
  comments     INT NOT NULL,
  PRIMARY KEY (post_id, snapshot_at)
);

CREATE TABLE IF NOT EXISTS tracked_ad_edges (
  source_channel_id  UUID NOT NULL REFERENCES tracked_channels(id) ON DELETE CASCADE,
  target_channel_id  UUID REFERENCES tracked_channels(id) ON DELETE SET NULL,
  target_username    TEXT NOT NULL,
  target_kind        TEXT NOT NULL,
  ad_post_count      INT NOT NULL DEFAULT 1,
  first_seen_at      TIMESTAMPTZ NOT NULL,
  last_seen_at       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (source_channel_id, LOWER(target_username), target_kind)
);
CREATE INDEX IF NOT EXISTS idx_tracked_ad_edges_target
  ON tracked_ad_edges (target_channel_id)
  WHERE target_channel_id IS NOT NULL;
```

- [ ] **Step 2: Apply migration locally**

```bash
docker compose up -d postgres
pnpm run dev:automation
```

Expected: bootstrap log contains `Applying migration: 002_tracking`.

- [ ] **Step 3: Verify in psql**

```bash
docker compose exec postgres psql -U ai0 -d ai0global \
  -c "SELECT tablename FROM pg_tables WHERE tablename LIKE 'tracked_%' ORDER BY tablename;"
```

Expected: 5 rows: `tracked_ad_edges`, `tracked_channels`, `tracked_post_metrics_history`, `tracked_posts`, `tracked_subs_history`.

- [ ] **Step 4: Commit**

```bash
git add database/migrations/002_tracking.sql
git commit -m "feat(tracking): add 002_tracking migration with 5 tables"
```

---

## Task 3: Shared types

**Files:**
- Create: `apps/automation/src/tracking/types.ts`

- [ ] **Step 1: Define shared types**

```ts
// apps/automation/src/tracking/types.ts

/** A reference to another channel/account/URL extracted from a post body or metadata. */
export type AdRef =
  | { kind: 'tg_channel'; username: string; target_post_id?: number; forward?: boolean }
  | { kind: 'tg_user';    username: string; forward?: boolean }
  | { kind: 'instagram';  username: string }
  | { kind: 'web';        domain: string };

/** BullMQ queue names. Kept as a const enum-ish object for type-safety. */
export const TRACKING_QUEUES = {
  POLL_META:          'tracking.poll-meta',
  POLL_POSTS:         'tracking.poll-posts',
  REFRESH_METRICS:    'tracking.refresh-metrics',
  RESOLVE_DISCOVERY:  'tracking.resolve-discovery',
} as const;

export type PollMetaJob          = { channelId: string };
export type PollPostsJob         = { channelId: string };
export type RefreshMetricsJob    = { postId: string };
export type ResolveDiscoveryJob  = { username: string; sourceChannelId: string };

export type PollTier = 'hot' | 'warm' | 'cold';
```

- [ ] **Step 2: Commit**

```bash
git add apps/automation/src/tracking/types.ts
git commit -m "feat(tracking): shared types and queue-name constants"
```

---

## Task 4: Pure processor — `tierClassifier`

**Files:**
- Create: `apps/automation/src/tracking/processors/tier-classifier.ts`
- Create: `apps/automation/src/tracking/processors/tier-classifier.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/automation/src/tracking/processors/tier-classifier.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTier } from './tier-classifier';

test('classifyTier: returns "hot" when ≥ 3 posts/day', () => {
  assert.equal(classifyTier({ postsLast7d: 21 }), 'hot');
  assert.equal(classifyTier({ postsLast7d: 50 }), 'hot');
});

test('classifyTier: returns "warm" for 0.5–3 posts/day', () => {
  assert.equal(classifyTier({ postsLast7d: 4 }),  'warm');  // ~0.57/day
  assert.equal(classifyTier({ postsLast7d: 20 }), 'warm'); // ~2.86/day
});

test('classifyTier: returns "cold" for < 0.5 posts/day', () => {
  assert.equal(classifyTier({ postsLast7d: 3 }), 'cold'); // ~0.43/day
  assert.equal(classifyTier({ postsLast7d: 0 }), 'cold');
});

test('classifyTier: returns "warm" for brand-new channels (no history)', () => {
  assert.equal(classifyTier({ postsLast7d: 0, daysSinceAdded: 0 }), 'warm');
  assert.equal(classifyTier({ postsLast7d: 0, daysSinceAdded: 2 }), 'warm');
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
npx tsx --test apps/automation/src/tracking/processors/tier-classifier.test.ts
```

Expected: FAIL — `Cannot find module './tier-classifier'`.

- [ ] **Step 3: Implement**

```ts
// apps/automation/src/tracking/processors/tier-classifier.ts
import { PollTier } from '../types';

export interface TierInput {
  postsLast7d:     number;
  daysSinceAdded?: number; // optional; < 3 → keep warm regardless
}

/**
 * Tier decision per spec:
 *   ≥ 3 posts/day   → hot
 *   0.5–3 posts/day → warm
 *   < 0.5 posts/day → cold
 * Brand-new channels (< 3 days of history) always classify as warm so they
 * get a fair polling cadence before being demoted to cold.
 */
export function classifyTier(input: TierInput): PollTier {
  if ((input.daysSinceAdded ?? Infinity) < 3) return 'warm';

  const perDay = input.postsLast7d / 7;
  if (perDay >= 3)   return 'hot';
  if (perDay >= 0.5) return 'warm';
  return 'cold';
}
```

- [ ] **Step 4: Run tests (expect pass)**

```bash
npx tsx --test apps/automation/src/tracking/processors/tier-classifier.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/tracking/processors/tier-classifier.{ts,test.ts}
git commit -m "feat(tracking): tier classifier (hot/warm/cold)"
```

---

## Task 5: Pure processor — `adRefExtractor`

**Files:**
- Create: `apps/automation/src/tracking/processors/ad-ref-extractor.ts`
- Create: `apps/automation/src/tracking/processors/ad-ref-extractor.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/automation/src/tracking/processors/ad-ref-extractor.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAdRefs } from './ad-ref-extractor';

test('extractAdRefs: captures forward source', () => {
  const refs = extractAdRefs({
    text: 'Some content',
    forwardFromUsername: 'somenews',
    entities: [],
  });
  assert.deepEqual(refs, [{ kind: 'tg_channel', username: 'somenews', forward: true }]);
});

test('extractAdRefs: captures @mention', () => {
  const refs = extractAdRefs({
    text: 'Підпишись на @awesome_channel — там круто',
    entities: [{ type: 'mention', offset: 13, length: 17 }],
  });
  assert.deepEqual(refs, [{ kind: 'tg_channel', username: 'awesome_channel' }]);
});

test('extractAdRefs: parses t.me/<u>/<id> URL with post id', () => {
  const refs = extractAdRefs({
    text: 'Дивись https://t.me/foochan/42',
    entities: [{ type: 'url', offset: 7, length: 23 }],
  });
  assert.deepEqual(refs, [{ kind: 'tg_channel', username: 'foochan', target_post_id: 42 }]);
});

test('extractAdRefs: parses t.me/<u> URL without post id', () => {
  const refs = extractAdRefs({
    text: 'Цей канал → https://t.me/barchan',
    entities: [{ type: 'url', offset: 13, length: 19 }],
  });
  assert.deepEqual(refs, [{ kind: 'tg_channel', username: 'barchan' }]);
});

test('extractAdRefs: captures instagram.com link', () => {
  const refs = extractAdRefs({
    text: 'Insta: https://instagram.com/cool.brand',
    entities: [{ type: 'url', offset: 7, length: 32 }],
  });
  assert.deepEqual(refs, [{ kind: 'instagram', username: 'cool.brand' }]);
});

test('extractAdRefs: captures generic web link by domain', () => {
  const refs = extractAdRefs({
    text: 'See https://example.com/page',
    entities: [{ type: 'url', offset: 4, length: 24 }],
  });
  assert.deepEqual(refs, [{ kind: 'web', domain: 'example.com' }]);
});

test('extractAdRefs: deduplicates same target across mention + url', () => {
  const refs = extractAdRefs({
    text: 'See @foochan or https://t.me/foochan',
    entities: [
      { type: 'mention', offset: 4, length: 8 },
      { type: 'url',     offset: 16, length: 20 },
    ],
  });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].kind, 'tg_channel');
});

test('extractAdRefs: returns empty array when no refs', () => {
  const refs = extractAdRefs({ text: 'plain text', entities: [] });
  assert.deepEqual(refs, []);
});

test('extractAdRefs: lowercases tg usernames', () => {
  const refs = extractAdRefs({
    text: '@FooChannel',
    entities: [{ type: 'mention', offset: 0, length: 11 }],
  });
  assert.equal((refs[0] as any).username, 'foochannel');
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
npx tsx --test apps/automation/src/tracking/processors/ad-ref-extractor.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/automation/src/tracking/processors/ad-ref-extractor.ts
import { AdRef } from '../types';

export interface MessageEntity {
  type:   'mention' | 'mention_name' | 'url' | 'text_url' | string;
  offset: number;
  length: number;
  url?:   string;  // for text_url
}

export interface ExtractInput {
  text:                 string;
  entities:             MessageEntity[];
  forwardFromUsername?: string | null;
}

const TME_RE       = /^https?:\/\/t\.me\/([A-Za-z0-9_]+)(?:\/(\d+))?/i;
const INSTA_RE     = /^https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]+)/i;
const GENERIC_RE   = /^https?:\/\/(?:www\.)?([A-Za-z0-9.\-]+)/i;
const MENTION_RE   = /^@?([A-Za-z0-9_]+)$/;

export function extractAdRefs(input: ExtractInput): AdRef[] {
  const refs: AdRef[] = [];
  const seen = new Set<string>();

  const push = (ref: AdRef) => {
    const key = `${ref.kind}:${(ref as any).username ?? (ref as any).domain}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };

  // 1. Forward source — highest precedence
  if (input.forwardFromUsername) {
    push({ kind: 'tg_channel', username: input.forwardFromUsername.toLowerCase(), forward: true });
  }

  // 2. Entities (mention, url, text_url)
  for (const e of input.entities) {
    const slice = input.text.slice(e.offset, e.offset + e.length);
    const url   = (e as any).url ?? slice;

    if (e.type === 'mention') {
      const m = MENTION_RE.exec(slice);
      if (m) push({ kind: 'tg_channel', username: m[1].toLowerCase() });
      continue;
    }

    if (e.type === 'url' || e.type === 'text_url') {
      const tme = TME_RE.exec(url);
      if (tme) {
        const ref: AdRef = { kind: 'tg_channel', username: tme[1].toLowerCase() };
        if (tme[2]) (ref as any).target_post_id = parseInt(tme[2], 10);
        push(ref);
        continue;
      }
      const ig = INSTA_RE.exec(url);
      if (ig) { push({ kind: 'instagram', username: ig[1].toLowerCase() }); continue; }
      const g = GENERIC_RE.exec(url);
      if (g)  { push({ kind: 'web', domain: g[1].toLowerCase() }); continue; }
    }
  }

  return refs;
}
```

- [ ] **Step 4: Run tests (expect pass)**

```bash
npx tsx --test apps/automation/src/tracking/processors/ad-ref-extractor.test.ts
```

Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/tracking/processors/ad-ref-extractor.{ts,test.ts}
git commit -m "feat(tracking): ad-ref extractor (forwards + mentions + URLs)"
```

---

## Task 6: Pure processor — `roiHeuristic`

**Files:**
- Create: `apps/automation/src/tracking/processors/roi-heuristic.ts`
- Create: `apps/automation/src/tracking/processors/roi-heuristic.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/automation/src/tracking/processors/roi-heuristic.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateRoi } from './roi-heuristic';

test('estimateRoi: high engagement multiplies estimate by 1.5', () => {
  const r = estimateRoi({
    avgViews: 10_000,
    subs: 5_000,
    engagementRate: 0.07, // > 5%
    daysHistory: 60, postsCount: 100,
    viewToSubRate: 0.02,
  });
  // 10_000 * 0.02 * 1.5 = 300
  assert.equal(r.estimated_subs_per_ad, 300);
  assert.equal(r.confidence, 'high');
});

test('estimateRoi: low engagement halves estimate', () => {
  const r = estimateRoi({
    avgViews: 10_000, subs: 5_000, engagementRate: 0.005,
    daysHistory: 60, postsCount: 100, viewToSubRate: 0.02,
  });
  // 10_000 * 0.02 * 0.5 = 100
  assert.equal(r.estimated_subs_per_ad, 100);
});

test('estimateRoi: medium engagement uses neutral multiplier', () => {
  const r = estimateRoi({
    avgViews: 1_000, subs: 500, engagementRate: 0.03,
    daysHistory: 60, postsCount: 100, viewToSubRate: 0.02,
  });
  assert.equal(r.estimated_subs_per_ad, 20);
});

test('estimateRoi: confidence "medium" for 14-29 days history', () => {
  const r = estimateRoi({
    avgViews: 1000, subs: 500, engagementRate: 0.03,
    daysHistory: 20, postsCount: 25, viewToSubRate: 0.02,
  });
  assert.equal(r.confidence, 'medium');
});

test('estimateRoi: confidence "low" for fresh channels', () => {
  const r = estimateRoi({
    avgViews: 1000, subs: 500, engagementRate: 0.03,
    daysHistory: 3, postsCount: 5, viewToSubRate: 0.02,
  });
  assert.equal(r.confidence, 'low');
});

test('estimateRoi: zero views returns zero estimate', () => {
  const r = estimateRoi({
    avgViews: 0, subs: 1000, engagementRate: 0,
    daysHistory: 60, postsCount: 100, viewToSubRate: 0.02,
  });
  assert.equal(r.estimated_subs_per_ad, 0);
});
```

- [ ] **Step 2: Run tests (expect fail)**

```bash
npx tsx --test apps/automation/src/tracking/processors/roi-heuristic.test.ts
```

- [ ] **Step 3: Implement**

```ts
// apps/automation/src/tracking/processors/roi-heuristic.ts

export interface RoiInput {
  avgViews:        number;
  subs:            number;
  engagementRate:  number; // (reactions + forwards + comments) / views
  daysHistory:     number;
  postsCount:      number;
  viewToSubRate:   number; // env-configurable, default 0.02
}

export interface RoiResult {
  estimated_subs_per_ad: number;
  confidence:            'low' | 'medium' | 'high';
  basis:                 string;
  inputs:                { avg_views: number; subs: number; engagement_rate: number };
}

function engagementMultiplier(rate: number): number {
  if (rate < 0.01) return 0.5;
  if (rate > 0.05) return 1.5;
  return 1.0;
}

function confidenceLevel(daysHistory: number, postsCount: number): 'low' | 'medium' | 'high' {
  if (daysHistory >= 30 && postsCount >= 50) return 'high';
  if (daysHistory >= 14 && postsCount >= 20) return 'medium';
  return 'low';
}

export function estimateRoi(input: RoiInput): RoiResult {
  const mult     = engagementMultiplier(input.engagementRate);
  const estimate = Math.round(input.avgViews * input.viewToSubRate * mult);

  return {
    estimated_subs_per_ad: estimate,
    confidence:            confidenceLevel(input.daysHistory, input.postsCount),
    basis:                 `avg_views × view_to_sub_rate × engagement_multiplier (${mult})`,
    inputs: {
      avg_views:       input.avgViews,
      subs:            input.subs,
      engagement_rate: Number(input.engagementRate.toFixed(4)),
    },
  };
}
```

- [ ] **Step 4: Run tests (expect pass)**

```bash
npx tsx --test apps/automation/src/tracking/processors/roi-heuristic.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/tracking/processors/roi-heuristic.{ts,test.ts}
git commit -m "feat(tracking): heuristic ROI estimator"
```

---

## Task 7: `TrackedChannelsRepository`

**Files:**
- Create: `apps/automation/src/tracking/repositories/tracked-channels.repository.ts`

- [ ] **Step 1: Implement the repository**

```ts
// apps/automation/src/tracking/repositories/tracked-channels.repository.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.tokens';
import { PollTier } from '../types';

export interface TrackedChannel {
  id:             string;
  tgChatId:       string | null;       // BIGINT — return as string to avoid JS precision loss
  username:       string | null;
  title:          string | null;
  about:          string | null;
  category:       string | null;
  isMine:         boolean;
  isClosed:       boolean;
  pollTier:       PollTier;
  subsCount:      number | null;
  addedAt:        Date;
  lastPolledAt:   Date | null;
}

export interface UpsertChannelInput {
  username?:    string | null;
  tgChatId?:    string | null;
  title?:       string | null;
  about?:       string | null;
  isMine?:      boolean;
  isClosed?:    boolean;
  pollTier?:    PollTier;
  subsCount?:   number | null;
  meta?:        unknown;
}

@Injectable()
export class TrackedChannelsRepository {
  private readonly logger = new Logger(TrackedChannelsRepository.name);

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async getById(id: string): Promise<TrackedChannel | null> {
    const r = await this.pool.query<any>(
      `SELECT * FROM tracked_channels WHERE id = $1`, [id],
    );
    return r.rows[0] ? this.toEntity(r.rows[0]) : null;
  }

  async getByUsername(username: string): Promise<TrackedChannel | null> {
    const r = await this.pool.query<any>(
      `SELECT * FROM tracked_channels WHERE LOWER(username) = LOWER($1)`, [username],
    );
    return r.rows[0] ? this.toEntity(r.rows[0]) : null;
  }

  /**
   * Insert if username is new; otherwise update non-null fields. Returns the
   * row's UUID. Used by the manual-add endpoint and by discovery.
   */
  async upsertByUsername(input: UpsertChannelInput & { username: string }): Promise<string> {
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO tracked_channels
         (username, tg_chat_id, title, about, is_mine, is_closed, poll_tier, subs_count, meta)
       VALUES ($1, $2, $3, $4, COALESCE($5,false), COALESCE($6,false),
               COALESCE($7,'warm'), $8, $9::jsonb)
       ON CONFLICT (LOWER(username))
       WHERE username IS NOT NULL
       DO UPDATE SET
         tg_chat_id = COALESCE(EXCLUDED.tg_chat_id, tracked_channels.tg_chat_id),
         title      = COALESCE(EXCLUDED.title,      tracked_channels.title),
         about      = COALESCE(EXCLUDED.about,      tracked_channels.about),
         is_closed  = COALESCE(EXCLUDED.is_closed,  tracked_channels.is_closed),
         poll_tier  = COALESCE(EXCLUDED.poll_tier,  tracked_channels.poll_tier),
         subs_count = COALESCE(EXCLUDED.subs_count, tracked_channels.subs_count),
         meta       = COALESCE(EXCLUDED.meta,       tracked_channels.meta)
       RETURNING id`,
      [
        input.username,
        input.tgChatId,
        input.title ?? null,
        input.about ?? null,
        input.isMine ?? null,
        input.isClosed ?? null,
        input.pollTier ?? null,
        input.subsCount ?? null,
        input.meta ? JSON.stringify(input.meta) : null,
      ],
    );
    return r.rows[0].id;
  }

  async listForPolling(tier: PollTier, olderThan: Date, limit: number): Promise<TrackedChannel[]> {
    const r = await this.pool.query<any>(
      `SELECT * FROM tracked_channels
       WHERE poll_tier = $1
         AND is_closed = FALSE
         AND (last_polled_at IS NULL OR last_polled_at < $2)
       ORDER BY last_polled_at NULLS FIRST
       LIMIT $3`,
      [tier, olderThan, limit],
    );
    return r.rows.map((row) => this.toEntity(row));
  }

  async markPolled(channelId: string, subsCount: number | null, snapshotAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE tracked_channels
       SET last_polled_at = $2,
           subs_count     = COALESCE($3, subs_count)
       WHERE id = $1`,
      [channelId, snapshotAt, subsCount],
    );
    if (subsCount !== null) {
      await this.pool.query(
        `INSERT INTO tracked_subs_history (channel_id, snapshot_at, subs_count)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [channelId, snapshotAt, subsCount],
      );
    }
  }

  async list(filter: {
    is_mine?: boolean;
    tier?:    PollTier;
    q?:       string;
    limit:    number;
    offset:   number;
  }): Promise<{ items: TrackedChannel[]; total: number }> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.is_mine !== undefined) { args.push(filter.is_mine); where.push(`is_mine = $${args.length}`); }
    if (filter.tier)                  { args.push(filter.tier);    where.push(`poll_tier = $${args.length}`); }
    if (filter.q)                     { args.push(`%${filter.q.toLowerCase()}%`); where.push(`LOWER(COALESCE(title,'') || ' ' || COALESCE(username,'')) LIKE $${args.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalR = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tracked_channels ${whereSql}`, args,
    );
    args.push(filter.limit);  const limitArg  = `$${args.length}`;
    args.push(filter.offset); const offsetArg = `$${args.length}`;

    const itemsR = await this.pool.query<any>(
      `SELECT * FROM tracked_channels ${whereSql}
       ORDER BY added_at DESC LIMIT ${limitArg} OFFSET ${offsetArg}`,
      args,
    );

    return {
      items: itemsR.rows.map((r) => this.toEntity(r)),
      total: parseInt(totalR.rows[0].count, 10),
    };
  }

  async softDelete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM tracked_channels WHERE id = $1`, [id]);
  }

  async subsHistory(channelId: string, from: Date | null, to: Date | null):
    Promise<{ snapshotAt: Date; subsCount: number }[]> {
    const args: unknown[] = [channelId];
    let where = `channel_id = $1`;
    if (from) { args.push(from); where += ` AND snapshot_at >= $${args.length}`; }
    if (to)   { args.push(to);   where += ` AND snapshot_at <= $${args.length}`; }
    const r = await this.pool.query<{ snapshot_at: Date; subs_count: number }>(
      `SELECT snapshot_at, subs_count FROM tracked_subs_history
       WHERE ${where} ORDER BY snapshot_at ASC`,
      args,
    );
    return r.rows.map((row) => ({ snapshotAt: row.snapshot_at, subsCount: row.subs_count }));
  }

  async listDiscoveryCandidates(): Promise<{
    id: string; username: string | null; isClosed: boolean; addedAt: Date;
  }[]> {
    const r = await this.pool.query<any>(
      `SELECT id, username, is_closed, added_at FROM tracked_channels
       WHERE is_closed = TRUE OR (last_polled_at IS NULL AND added_at < now() - INTERVAL '1 hour')
       ORDER BY added_at DESC LIMIT 200`,
    );
    return r.rows.map((row) => ({
      id: row.id, username: row.username, isClosed: row.is_closed, addedAt: row.added_at,
    }));
  }

  private toEntity(r: any): TrackedChannel {
    return {
      id:           r.id,
      tgChatId:     r.tg_chat_id !== null ? String(r.tg_chat_id) : null,
      username:     r.username,
      title:        r.title,
      about:        r.about,
      category:     r.category,
      isMine:       r.is_mine,
      isClosed:     r.is_closed,
      pollTier:     r.poll_tier,
      subsCount:    r.subs_count,
      addedAt:      r.added_at,
      lastPolledAt: r.last_polled_at,
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/automation/src/tracking/repositories/tracked-channels.repository.ts
git commit -m "feat(tracking): TrackedChannelsRepository with upsert, list, polling helpers"
```

---

## Task 8: `TrackedPostsRepository`

**Files:**
- Create: `apps/automation/src/tracking/repositories/tracked-posts.repository.ts`

- [ ] **Step 1: Implement**

```ts
// apps/automation/src/tracking/repositories/tracked-posts.repository.ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.tokens';
import { AdRef } from '../types';

export interface TrackedPost {
  id:              string;
  channelId:       string;
  tgMessageId:     string;
  text:            string | null;
  hasMedia:        boolean;
  mediaType:       string | null;
  postedAt:        Date;
  views:           number | null;
  forwards:        number | null;
  reactionsTotal:  number | null;
  reactions:       Record<string, number> | null;
  commentsCount:   number | null;
  adRefs:          AdRef[] | null;
  lastMetricsAt:   Date | null;
}

export interface UpsertPostInput {
  channelId:      string;
  tgMessageId:    string | number;
  text?:          string | null;
  hasMedia?:      boolean;
  mediaType?:     string | null;
  postedAt:       Date;
  views?:         number | null;
  forwards?:      number | null;
  reactionsTotal?: number | null;
  reactions?:     Record<string, number> | null;
  commentsCount?: number | null;
  adRefs?:        AdRef[] | null;
}

@Injectable()
export class TrackedPostsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async upsert(input: UpsertPostInput): Promise<string> {
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO tracked_posts
         (channel_id, tg_message_id, text, has_media, media_type, posted_at,
          views, forwards, reactions_total, reactions, comments_count, ad_refs, last_metrics_at)
       VALUES ($1, $2, $3, COALESCE($4,false), $5, $6,
               $7, $8, $9, $10::jsonb, $11, $12::jsonb, now())
       ON CONFLICT (channel_id, tg_message_id)
       DO UPDATE SET
         text            = COALESCE(EXCLUDED.text,            tracked_posts.text),
         has_media       = COALESCE(EXCLUDED.has_media,       tracked_posts.has_media),
         media_type      = COALESCE(EXCLUDED.media_type,      tracked_posts.media_type),
         views           = COALESCE(EXCLUDED.views,           tracked_posts.views),
         forwards        = COALESCE(EXCLUDED.forwards,        tracked_posts.forwards),
         reactions_total = COALESCE(EXCLUDED.reactions_total, tracked_posts.reactions_total),
         reactions       = COALESCE(EXCLUDED.reactions,       tracked_posts.reactions),
         comments_count  = COALESCE(EXCLUDED.comments_count,  tracked_posts.comments_count),
         ad_refs         = COALESCE(EXCLUDED.ad_refs,         tracked_posts.ad_refs),
         last_metrics_at = now()
       RETURNING id`,
      [
        input.channelId,
        String(input.tgMessageId),
        input.text ?? null,
        input.hasMedia ?? null,
        input.mediaType ?? null,
        input.postedAt,
        input.views ?? null,
        input.forwards ?? null,
        input.reactionsTotal ?? null,
        input.reactions ? JSON.stringify(input.reactions) : null,
        input.commentsCount ?? null,
        input.adRefs && input.adRefs.length > 0 ? JSON.stringify(input.adRefs) : null,
      ],
    );
    return r.rows[0].id;
  }

  async getMaxMessageId(channelId: string): Promise<number> {
    const r = await this.pool.query<{ max: string | null }>(
      `SELECT MAX(tg_message_id)::text AS max FROM tracked_posts WHERE channel_id = $1`,
      [channelId],
    );
    return r.rows[0].max ? parseInt(r.rows[0].max, 10) : 0;
  }

  async countLast7Days(channelId: string): Promise<number> {
    const r = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tracked_posts
       WHERE channel_id = $1 AND posted_at > now() - INTERVAL '7 days'`,
      [channelId],
    );
    return parseInt(r.rows[0].count, 10);
  }

  async listByChannel(
    channelId: string, from: Date | null, to: Date | null, limit: number, offset: number,
  ): Promise<{ items: TrackedPost[]; total: number }> {
    const args: unknown[] = [channelId];
    let where = `channel_id = $1`;
    if (from) { args.push(from); where += ` AND posted_at >= $${args.length}`; }
    if (to)   { args.push(to);   where += ` AND posted_at <= $${args.length}`; }

    const totalR = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tracked_posts WHERE ${where}`, args,
    );
    args.push(limit);  const lim = `$${args.length}`;
    args.push(offset); const off = `$${args.length}`;
    const itemsR = await this.pool.query<any>(
      `SELECT * FROM tracked_posts WHERE ${where} ORDER BY posted_at DESC LIMIT ${lim} OFFSET ${off}`,
      args,
    );
    return {
      items: itemsR.rows.map((r) => this.toEntity(r)),
      total: parseInt(totalR.rows[0].count, 10),
    };
  }

  async topByMetric(channelId: string, metric: 'views' | 'reactions_total' | 'forwards', limit: number) {
    const allowed = ['views', 'reactions_total', 'forwards'];
    if (!allowed.includes(metric)) throw new Error(`Disallowed metric: ${metric}`);
    const r = await this.pool.query<any>(
      `SELECT * FROM tracked_posts WHERE channel_id = $1
       ORDER BY ${metric} DESC NULLS LAST LIMIT $2`,
      [channelId, limit],
    );
    return r.rows.map((row) => this.toEntity(row));
  }

  /** For ROI: mean views over last 30 days, with engagement aggregate. */
  async statsLast30Days(channelId: string): Promise<{ avgViews: number; engagementRate: number; postsCount: number }> {
    const r = await this.pool.query<any>(
      `SELECT
         AVG(views)::float AS avg_views,
         SUM(COALESCE(reactions_total,0) + COALESCE(forwards,0) + COALESCE(comments_count,0))::float AS sum_engage,
         SUM(views)::float AS sum_views,
         COUNT(*)::int AS posts
       FROM tracked_posts
       WHERE channel_id = $1 AND posted_at > now() - INTERVAL '30 days'`,
      [channelId],
    );
    const row = r.rows[0];
    const avgViews = row.avg_views ?? 0;
    const rate     = row.sum_views > 0 ? row.sum_engage / row.sum_views : 0;
    return { avgViews, engagementRate: rate, postsCount: row.posts ?? 0 };
  }

  private toEntity(r: any): TrackedPost {
    return {
      id:             r.id,
      channelId:      r.channel_id,
      tgMessageId:    String(r.tg_message_id),
      text:           r.text,
      hasMedia:       r.has_media,
      mediaType:      r.media_type,
      postedAt:       r.posted_at,
      views:          r.views,
      forwards:       r.forwards,
      reactionsTotal: r.reactions_total,
      reactions:      r.reactions,
      commentsCount:  r.comments_count,
      adRefs:         r.ad_refs,
      lastMetricsAt:  r.last_metrics_at,
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/automation/src/tracking/repositories/tracked-posts.repository.ts
git commit -m "feat(tracking): TrackedPostsRepository with upsert, queries, ROI stats"
```

---

## Task 9: `TrackedEdgesRepository`

**Files:**
- Create: `apps/automation/src/tracking/repositories/tracked-edges.repository.ts`

- [ ] **Step 1: Implement**

```ts
// apps/automation/src/tracking/repositories/tracked-edges.repository.ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.tokens';

export interface AdEdgeUpsert {
  sourceChannelId: string;
  targetUsername:  string;
  targetKind:      'tg_channel' | 'tg_user' | 'instagram' | 'web';
  targetChannelId?: string | null;
  seenAt:          Date;
}

export interface EdgeRow {
  source_channel_id: string;
  target_channel_id: string | null;
  target_username:   string;
  target_kind:       string;
  ad_post_count:     number;
  first_seen_at:     Date;
  last_seen_at:      Date;
}

@Injectable()
export class TrackedEdgesRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /** Increment ad_post_count for the (source, target) pair; insert if new. */
  async upsertSeen(input: AdEdgeUpsert): Promise<void> {
    await this.pool.query(
      `INSERT INTO tracked_ad_edges
         (source_channel_id, target_channel_id, target_username, target_kind,
          ad_post_count, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, 1, $5, $5)
       ON CONFLICT (source_channel_id, LOWER(target_username), target_kind)
       DO UPDATE SET
         ad_post_count    = tracked_ad_edges.ad_post_count + 1,
         target_channel_id = COALESCE(EXCLUDED.target_channel_id, tracked_ad_edges.target_channel_id),
         last_seen_at     = GREATEST(tracked_ad_edges.last_seen_at, EXCLUDED.last_seen_at)`,
      [
        input.sourceChannelId,
        input.targetChannelId ?? null,
        input.targetUsername,
        input.targetKind,
        input.seenAt,
      ],
    );
  }

  /** Backfill target_channel_id once a previously-unknown channel gets tracked. */
  async linkResolvedTarget(targetUsername: string, channelId: string): Promise<void> {
    await this.pool.query(
      `UPDATE tracked_ad_edges
       SET target_channel_id = $2
       WHERE LOWER(target_username) = LOWER($1) AND target_channel_id IS NULL`,
      [targetUsername, channelId],
    );
  }

  async graph(from: Date | null, to: Date | null, minWeight: number): Promise<EdgeRow[]> {
    const args: unknown[] = [minWeight];
    let where = `ad_post_count >= $1`;
    if (from) { args.push(from); where += ` AND last_seen_at >= $${args.length}`; }
    if (to)   { args.push(to);   where += ` AND first_seen_at <= $${args.length}`; }
    const r = await this.pool.query<EdgeRow>(
      `SELECT * FROM tracked_ad_edges WHERE ${where}`, args,
    );
    return r.rows;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/automation/src/tracking/repositories/tracked-edges.repository.ts
git commit -m "feat(tracking): TrackedEdgesRepository with upsert and graph query"
```

---

## Task 10: `TrackingMtprotoClient`

**Files:**
- Create: `apps/automation/src/tracking/mtproto/tracking-mtproto.client.ts`

This extends the existing `TelegramStatsClient` pattern. It exposes 3 methods: `getFullChannel(usernameOrId)`, `getHistory(usernameOrId, offsetId)`, `resolveUsername(username)`.

- [ ] **Step 1: Implement**

```ts
// apps/automation/src/tracking/mtproto/tracking-mtproto.client.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramClient, Api } from 'telegram';
import { StringSession }       from 'telegram/sessions';

export interface FullChannelResult {
  tgChatId:    string;
  username:    string | null;
  title:       string | null;
  about:       string | null;
  subsCount:   number | null;
}

export interface RawMessage {
  id:                  number;
  date:                Date;
  text:                string;
  hasMedia:            boolean;
  mediaType:           'photo' | 'video' | 'document' | null;
  views:               number | null;
  forwards:            number | null;
  replies:             number | null;
  reactionsTotal:      number;
  reactions:           Record<string, number> | null;
  entities:            { type: string; offset: number; length: number; url?: string }[];
  forwardFromUsername: string | null;
}

export interface ResolveResult {
  tgChatId:  string;
  username:  string;
  title:     string | null;
  isClosed:  boolean;
}

const FLOOD_WAIT_RE = /A wait of (\d+) seconds is required/;

@Injectable()
export class TrackingMtprotoClient implements OnModuleInit {
  private readonly logger = new Logger(TrackingMtprotoClient.name);
  private client: TelegramClient | null = null;
  private ready  = false;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const apiId   = parseInt(this.config.get<string>('TELEGRAM_API_ID') ?? '', 10);
    const apiHash = this.config.get<string>('TELEGRAM_API_HASH') ?? '';
    const session = this.config.get<string>('TELEGRAM_SESSION_STRING') ?? '';
    if (!apiId || !apiHash || !session) {
      this.logger.warn('TrackingMtprotoClient disabled: missing credentials');
      return;
    }
    this.client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 5 });
    await this.client.connect();
    this.ready = true;
    this.logger.log('TrackingMtprotoClient ready');
  }

  isEnabled(): boolean { return this.ready; }

  async getFullChannel(usernameOrId: string): Promise<FullChannelResult | null> {
    if (!this.ready || !this.client) return null;
    try {
      const entity = await this.client.getEntity(usernameOrId);
      const full = await this.client.invoke(new Api.channels.GetFullChannel({ channel: entity as any }));
      const fc   = (full as any).fullChat;
      const ch   = (full as any).chats?.find((c: any) => String(c.id) === String((entity as any).id));
      return {
        tgChatId:  String((entity as any).id),
        username:  ch?.username ?? null,
        title:     ch?.title ?? null,
        about:     fc?.about ?? null,
        subsCount: fc?.participantsCount ?? null,
      };
    } catch (err: any) {
      this.handleApiError('getFullChannel', err);
      return null;
    }
  }

  async getHistory(usernameOrId: string, offsetId: number, limit = 50): Promise<RawMessage[]> {
    if (!this.ready || !this.client) return [];
    try {
      const entity = await this.client.getEntity(usernameOrId);
      const res    = await this.client.invoke(
        new Api.messages.GetHistory({ peer: entity as any, limit, minId: offsetId, offsetId: 0 }),
      );
      const msgs   = (res as any).messages as any[];
      return msgs
        .filter((m) => m.className === 'Message')
        .map((m) => this.toRawMessage(m));
    } catch (err: any) {
      this.handleApiError('getHistory', err);
      return [];
    }
  }

  async resolveUsername(username: string): Promise<ResolveResult | null> {
    if (!this.ready || !this.client) return null;
    try {
      const res = await this.client.invoke(new Api.contacts.ResolveUsername({ username }));
      const ch  = (res as any).chats?.[0];
      if (!ch) return null;
      return {
        tgChatId: String(ch.id),
        username: ch.username ?? username,
        title:    ch.title ?? null,
        isClosed: !!ch.restricted || ch.access_hash === null,
      };
    } catch (err: any) {
      const msg = err.errorMessage ?? err.message ?? '';
      if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID/.test(msg)) {
        this.logger.debug(`ResolveUsername: ${username} not found`);
        return null;
      }
      if (/CHANNEL_PRIVATE/.test(msg)) {
        return { tgChatId: '', username, title: null, isClosed: true };
      }
      this.handleApiError('resolveUsername', err);
      return null;
    }
  }

  private toRawMessage(m: any): RawMessage {
    const reactions: Record<string, number> = {};
    let reactionsTotal = 0;
    for (const r of m.reactions?.results ?? []) {
      const key = r.reaction?.emoticon ?? r.reaction?.documentId?.toString() ?? '?';
      reactions[key] = r.count;
      reactionsTotal += r.count;
    }
    return {
      id:                  m.id,
      date:                new Date(m.date * 1000),
      text:                m.message ?? '',
      hasMedia:            !!m.media,
      mediaType:           m.media?.className?.replace(/^MessageMedia/, '').toLowerCase() ?? null,
      views:               m.views ?? null,
      forwards:            m.forwards ?? null,
      replies:             m.replies?.replies ?? null,
      reactionsTotal,
      reactions:           Object.keys(reactions).length ? reactions : null,
      entities:            (m.entities ?? []).map((e: any) => ({
        type:   (e.className ?? '').replace(/^MessageEntity/, '').toLowerCase(),
        offset: e.offset, length: e.length, url: e.url,
      })),
      forwardFromUsername: m.fwdFrom?.fromName ?? null,
    };
  }

  /** Logs the error and re-throws FLOOD_WAIT so BullMQ can delay the job. */
  private handleApiError(where: string, err: any): void {
    const msg = err.errorMessage ?? err.message ?? '';
    const flood = FLOOD_WAIT_RE.exec(msg);
    if (flood) {
      this.logger.warn(`${where}: FLOOD_WAIT ${flood[1]}s`);
      const ts = parseInt(flood[1], 10);
      const e: any = new Error(`FLOOD_WAIT ${ts}`);
      e.floodWaitSeconds = ts;
      throw e;
    }
    this.logger.warn(`${where} failed: ${msg}`);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/automation/src/tracking/mtproto/tracking-mtproto.client.ts
git commit -m "feat(tracking): MTProto client wrappers (full channel, history, resolve)"
```

---

## Task 11: Redis provider + tokens

**Files:**
- Create: `apps/automation/src/tracking/tracking.tokens.ts`
- Create: `apps/automation/src/tracking/redis.provider.ts`

- [ ] **Step 1: Tokens**

```ts
// apps/automation/src/tracking/tracking.tokens.ts
export const REDIS = Symbol('REDIS');
```

- [ ] **Step 2: Provider**

```ts
// apps/automation/src/tracking/redis.provider.ts
import { Provider, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { REDIS } from './tracking.tokens';

export const RedisProvider: Provider = {
  provide: REDIS,
  inject:  [ConfigService],
  useFactory: (config: ConfigService) => {
    const url = config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
    const client = new IORedis(url, { maxRetriesPerRequest: null });
    const logger = new Logger('Redis');
    client.on('connect', () => logger.log(`connected to ${url}`));
    client.on('error',   (e) => logger.warn(`error: ${e.message}`));
    return client;
  },
};
```

- [ ] **Step 3: Commit**

```bash
git add apps/automation/src/tracking/tracking.tokens.ts apps/automation/src/tracking/redis.provider.ts
git commit -m "feat(tracking): Redis provider and DI token"
```

---

## Task 12: `TrackingQueueService` (BullMQ wrapper)

**Files:**
- Create: `apps/automation/src/tracking/tracking-queue.service.ts`

- [ ] **Step 1: Implement**

```ts
// apps/automation/src/tracking/tracking-queue.service.ts
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker, Job, WorkerOptions } from 'bullmq';
import IORedis from 'ioredis';
import { REDIS } from './tracking.tokens';
import {
  TRACKING_QUEUES, PollMetaJob, PollPostsJob, RefreshMetricsJob, ResolveDiscoveryJob,
} from './types';

@Injectable()
export class TrackingQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TrackingQueueService.name);
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];

  constructor(@Inject(REDIS) private readonly redis: IORedis) {}

  async onModuleInit(): Promise<void> {
    for (const name of Object.values(TRACKING_QUEUES)) {
      this.queues.set(name, new Queue(name, { connection: this.redis }));
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const w of this.workers) await w.close();
    for (const q of this.queues.values()) await q.close();
  }

  async addPollMeta(data: PollMetaJob): Promise<void> {
    await this.queues.get(TRACKING_QUEUES.POLL_META)!.add('poll-meta', data, {
      removeOnComplete: 1000, removeOnFail: 1000, attempts: 3, backoff: { type: 'exponential', delay: 5000 },
    });
  }

  async addPollPosts(data: PollPostsJob): Promise<void> {
    await this.queues.get(TRACKING_QUEUES.POLL_POSTS)!.add('poll-posts', data, {
      removeOnComplete: 1000, removeOnFail: 1000, attempts: 3, backoff: { type: 'exponential', delay: 5000 },
    });
  }

  async addRefreshMetrics(data: RefreshMetricsJob): Promise<void> {
    await this.queues.get(TRACKING_QUEUES.REFRESH_METRICS)!.add('refresh-metrics', data, {
      removeOnComplete: 500, removeOnFail: 500, attempts: 2,
    });
  }

  async addResolveDiscovery(data: ResolveDiscoveryJob): Promise<void> {
    await this.queues.get(TRACKING_QUEUES.RESOLVE_DISCOVERY)!.add('resolve-discovery', data, {
      removeOnComplete: 100, removeOnFail: 100, attempts: 1,
    });
  }

  /**
   * Register a worker for one queue with concurrency cap. Workers are stored
   * so onModuleDestroy can close them cleanly.
   */
  registerWorker<T>(
    queueName: string,
    processor: (job: Job<T>) => Promise<unknown>,
    concurrency = 5,
  ): void {
    const opts: WorkerOptions = { connection: this.redis, concurrency };
    const w = new Worker<T>(queueName, processor, opts);
    w.on('failed', (job, err) => this.logger.warn(`[${queueName}] job ${job?.id} failed: ${err.message}`));
    this.workers.push(w);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/automation/src/tracking/tracking-queue.service.ts
git commit -m "feat(tracking): BullMQ queue service with 4 named queues"
```

---

## Task 13: Worker — `poll-meta`

**Files:**
- Create: `apps/automation/src/tracking/workers/poll-meta.worker.ts`

- [ ] **Step 1: Implement**

```ts
// apps/automation/src/tracking/workers/poll-meta.worker.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { TrackingQueueService } from '../tracking-queue.service';
import { TrackedChannelsRepository } from '../repositories/tracked-channels.repository';
import { TrackingMtprotoClient } from '../mtproto/tracking-mtproto.client';
import { TRACKING_QUEUES, PollMetaJob } from '../types';

@Injectable()
export class PollMetaWorker implements OnModuleInit {
  private readonly logger = new Logger(PollMetaWorker.name);

  constructor(
    private readonly queue:    TrackingQueueService,
    private readonly channels: TrackedChannelsRepository,
    private readonly mtproto:  TrackingMtprotoClient,
  ) {}

  onModuleInit(): void {
    this.queue.registerWorker<PollMetaJob>(
      TRACKING_QUEUES.POLL_META,
      (job) => this.handle(job),
      3, // concurrency: this op is light, but rate-limit-sensitive
    );
  }

  private async handle(job: Job<PollMetaJob>): Promise<void> {
    const channel = await this.channels.getById(job.data.channelId);
    if (!channel) { this.logger.debug(`channel ${job.data.channelId} disappeared`); return; }

    const target = channel.tgChatId ?? channel.username;
    if (!target) { this.logger.warn(`channel ${channel.id} has neither tgChatId nor username`); return; }

    const meta = await this.mtproto.getFullChannel(target);
    if (!meta) { this.logger.debug(`getFullChannel returned null for ${target}`); return; }

    await this.channels.upsertByUsername({
      username:  meta.username ?? channel.username ?? undefined as any,
      tgChatId:  meta.tgChatId,
      title:     meta.title,
      about:     meta.about,
      subsCount: meta.subsCount,
    });
    await this.channels.markPolled(channel.id, meta.subsCount, new Date());
    this.logger.debug(`poll-meta ok: ${target} subs=${meta.subsCount}`);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/automation/src/tracking/workers/poll-meta.worker.ts
git commit -m "feat(tracking): poll-meta worker"
```

---

## Task 14: Worker — `poll-posts`

**Files:**
- Create: `apps/automation/src/tracking/workers/poll-posts.worker.ts`

- [ ] **Step 1: Implement**

```ts
// apps/automation/src/tracking/workers/poll-posts.worker.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { TrackingQueueService } from '../tracking-queue.service';
import { TrackedChannelsRepository } from '../repositories/tracked-channels.repository';
import { TrackedPostsRepository } from '../repositories/tracked-posts.repository';
import { TrackedEdgesRepository } from '../repositories/tracked-edges.repository';
import { TrackingMtprotoClient } from '../mtproto/tracking-mtproto.client';
import { extractAdRefs } from '../processors/ad-ref-extractor';
import { TRACKING_QUEUES, PollPostsJob } from '../types';

@Injectable()
export class PollPostsWorker implements OnModuleInit {
  private readonly logger = new Logger(PollPostsWorker.name);

  constructor(
    private readonly queue:    TrackingQueueService,
    private readonly channels: TrackedChannelsRepository,
    private readonly posts:    TrackedPostsRepository,
    private readonly edges:    TrackedEdgesRepository,
    private readonly mtproto:  TrackingMtprotoClient,
  ) {}

  onModuleInit(): void {
    this.queue.registerWorker<PollPostsJob>(TRACKING_QUEUES.POLL_POSTS, (job) => this.handle(job), 5);
  }

  private async handle(job: Job<PollPostsJob>): Promise<void> {
    const channel = await this.channels.getById(job.data.channelId);
    if (!channel) return;
    const target = channel.tgChatId ?? channel.username;
    if (!target) return;

    const sinceId = await this.posts.getMaxMessageId(channel.id);
    const msgs    = await this.mtproto.getHistory(target, sinceId, 50);
    if (msgs.length === 0) return;

    for (const m of msgs) {
      const adRefs = extractAdRefs({
        text:                m.text,
        entities:            m.entities,
        forwardFromUsername: m.forwardFromUsername,
      });
      await this.posts.upsert({
        channelId:      channel.id,
        tgMessageId:    m.id,
        text:           m.text,
        hasMedia:       m.hasMedia,
        mediaType:      m.mediaType,
        postedAt:       m.date,
        views:          m.views,
        forwards:       m.forwards,
        reactionsTotal: m.reactionsTotal,
        reactions:      m.reactions,
        commentsCount:  m.replies,
        adRefs:         adRefs.length ? adRefs : null,
      });

      for (const ref of adRefs) {
        if (ref.kind === 'tg_channel' || ref.kind === 'tg_user') {
          const existing = await this.channels.getByUsername(ref.username);
          await this.edges.upsertSeen({
            sourceChannelId: channel.id,
            targetUsername:  ref.username,
            targetKind:      ref.kind,
            targetChannelId: existing?.id ?? null,
            seenAt:          m.date,
          });
          if (!existing) {
            await this.queue.addResolveDiscovery({ username: ref.username, sourceChannelId: channel.id });
          }
        } else if (ref.kind === 'instagram' || ref.kind === 'web') {
          await this.edges.upsertSeen({
            sourceChannelId: channel.id,
            targetUsername:  ref.kind === 'instagram' ? ref.username : ref.domain,
            targetKind:      ref.kind,
            targetChannelId: null,
            seenAt:          m.date,
          });
        }
      }
    }
    this.logger.debug(`poll-posts ${channel.username ?? channel.id}: ${msgs.length} new posts`);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/automation/src/tracking/workers/poll-posts.worker.ts
git commit -m "feat(tracking): poll-posts worker (extract + persist + enqueue discovery)"
```

---

## Task 15: Worker — `refresh-metrics`

**Files:**
- Create: `apps/automation/src/tracking/workers/refresh-metrics.worker.ts`

- [ ] **Step 1: Implement**

```ts
// apps/automation/src/tracking/workers/refresh-metrics.worker.ts
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { Pool } from 'pg';
import { TrackingQueueService } from '../tracking-queue.service';
import { TrackedPostsRepository } from '../repositories/tracked-posts.repository';
import { TrackedChannelsRepository } from '../repositories/tracked-channels.repository';
import { TrackingMtprotoClient } from '../mtproto/tracking-mtproto.client';
import { DB_POOL } from '../../database/database.tokens';
import { TRACKING_QUEUES, RefreshMetricsJob } from '../types';

/**
 * Periodically refreshes metrics for the most recently posted N posts per channel.
 * Snapshot-writes go into tracked_post_metrics_history.
 */
@Injectable()
export class RefreshMetricsWorker implements OnModuleInit {
  private readonly logger = new Logger(RefreshMetricsWorker.name);

  constructor(
    private readonly queue:    TrackingQueueService,
    private readonly posts:    TrackedPostsRepository,
    private readonly channels: TrackedChannelsRepository,
    private readonly mtproto:  TrackingMtprotoClient,
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

  onModuleInit(): void {
    this.queue.registerWorker<RefreshMetricsJob>(
      TRACKING_QUEUES.REFRESH_METRICS,
      (job) => this.handle(job),
      3,
    );
  }

  private async handle(job: Job<RefreshMetricsJob>): Promise<void> {
    const r = await this.pool.query<any>(`SELECT * FROM tracked_posts WHERE id = $1`, [job.data.postId]);
    const post = r.rows[0];
    if (!post) return;

    const channel = await this.channels.getById(post.channel_id);
    if (!channel) return;
    const target = channel.tgChatId ?? channel.username;
    if (!target) return;

    const msgs = await this.mtproto.getHistory(target, parseInt(post.tg_message_id, 10) - 1, 1);
    const m = msgs.find((x) => x.id === parseInt(post.tg_message_id, 10));
    if (!m) return;

    await this.posts.upsert({
      channelId:      post.channel_id,
      tgMessageId:    post.tg_message_id,
      postedAt:       post.posted_at,
      views:          m.views,
      forwards:       m.forwards,
      reactionsTotal: m.reactionsTotal,
      reactions:      m.reactions,
      commentsCount:  m.replies,
    });

    await this.pool.query(
      `INSERT INTO tracked_post_metrics_history
         (post_id, snapshot_at, views, forwards, reactions, comments)
       VALUES ($1, now(), $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [post.id, m.views ?? 0, m.forwards ?? 0, m.reactionsTotal ?? 0, m.replies ?? 0],
    );
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/automation/src/tracking/workers/refresh-metrics.worker.ts
git commit -m "feat(tracking): refresh-metrics worker (snapshot history)"
```

---

## Task 16: Worker — `resolve-discovery`

**Files:**
- Create: `apps/automation/src/tracking/workers/resolve-discovery.worker.ts`

- [ ] **Step 1: Implement**

```ts
// apps/automation/src/tracking/workers/resolve-discovery.worker.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { TrackingQueueService } from '../tracking-queue.service';
import { TrackedChannelsRepository } from '../repositories/tracked-channels.repository';
import { TrackedEdgesRepository } from '../repositories/tracked-edges.repository';
import { TrackingMtprotoClient } from '../mtproto/tracking-mtproto.client';
import { TRACKING_QUEUES, ResolveDiscoveryJob } from '../types';

@Injectable()
export class ResolveDiscoveryWorker implements OnModuleInit {
  private readonly logger = new Logger(ResolveDiscoveryWorker.name);

  constructor(
    private readonly queue:    TrackingQueueService,
    private readonly channels: TrackedChannelsRepository,
    private readonly edges:    TrackedEdgesRepository,
    private readonly mtproto:  TrackingMtprotoClient,
  ) {}

  onModuleInit(): void {
    // Low concurrency — ResolveUsername counts against MTProto rate-limit hard.
    this.queue.registerWorker<ResolveDiscoveryJob>(
      TRACKING_QUEUES.RESOLVE_DISCOVERY,
      (job) => this.handle(job),
      1,
    );
  }

  private async handle(job: Job<ResolveDiscoveryJob>): Promise<void> {
    const { username } = job.data;
    const existing = await this.channels.getByUsername(username);
    if (existing) {
      await this.edges.linkResolvedTarget(username, existing.id);
      return;
    }
    const resolved = await this.mtproto.resolveUsername(username);
    if (!resolved) {
      this.logger.debug(`resolve-discovery: ${username} unresolved`);
      return;
    }
    const id = await this.channels.upsertByUsername({
      username: resolved.username,
      tgChatId: resolved.tgChatId || null,
      title:    resolved.title,
      isClosed: resolved.isClosed,
      pollTier: 'cold',
    });
    await this.edges.linkResolvedTarget(username, id);

    if (!resolved.isClosed) {
      await this.queue.addPollMeta({ channelId: id });
    }
    this.logger.debug(`resolve-discovery: ${username} → ${resolved.isClosed ? 'closed' : 'tracked'}`);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/automation/src/tracking/workers/resolve-discovery.worker.ts
git commit -m "feat(tracking): resolve-discovery worker"
```

---

## Task 17: `TrackingScheduler`

**Files:**
- Create: `apps/automation/src/tracking/tracking.scheduler.ts`

- [ ] **Step 1: Implement**

```ts
// apps/automation/src/tracking/tracking.scheduler.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { TrackedChannelsRepository } from './repositories/tracked-channels.repository';
import { TrackedPostsRepository } from './repositories/tracked-posts.repository';
import { TrackingQueueService } from './tracking-queue.service';
import { classifyTier } from './processors/tier-classifier';
import { PollTier } from './types';

@Injectable()
export class TrackingScheduler {
  private readonly logger = new Logger(TrackingScheduler.name);
  private readonly batchSize: number;

  constructor(
    private readonly config:   ConfigService,
    private readonly channels: TrackedChannelsRepository,
    private readonly posts:    TrackedPostsRepository,
    private readonly queue:    TrackingQueueService,
  ) {
    this.batchSize = parseInt(config.get<string>('TRACKING_BATCH_SIZE') ?? '50', 10);
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'tracking.tier-hot' })
  async pollHot(): Promise<void> {
    if (!this.enabled()) return;
    await this.enqueueTier('hot', 5);
  }

  @Cron('*/30 * * * *', { name: 'tracking.tier-warm' })
  async pollWarm(): Promise<void> {
    if (!this.enabled()) return;
    await this.enqueueTier('warm', 30);
  }

  @Cron('0 */6 * * *', { name: 'tracking.tier-cold' })
  async pollCold(): Promise<void> {
    if (!this.enabled()) return;
    await this.enqueueTier('cold', 360);
  }

  /** Daily recompute of poll_tier based on last-7-day post count. */
  @Cron('30 3 * * *', { name: 'tracking.recompute-tiers' })
  async recomputeTiers(): Promise<void> {
    if (!this.enabled()) return;
    const all = await this.channels.list({ limit: 10_000, offset: 0 });
    for (const ch of all.items) {
      const postsLast7d = await this.posts.countLast7Days(ch.id);
      const daysSinceAdded = Math.floor((Date.now() - ch.addedAt.getTime()) / 86_400_000);
      const newTier = classifyTier({ postsLast7d, daysSinceAdded });
      if (newTier !== ch.pollTier) {
        await this.channels.upsertByUsername({
          username: ch.username!,
          pollTier: newTier,
        });
        this.logger.debug(`tier change: ${ch.username} ${ch.pollTier} → ${newTier}`);
      }
    }
  }

  private async enqueueTier(tier: PollTier, intervalMin: number): Promise<void> {
    const olderThan = new Date(Date.now() - intervalMin * 60_000);
    const due = await this.channels.listForPolling(tier, olderThan, this.batchSize);
    for (const ch of due) {
      await this.queue.addPollMeta({ channelId: ch.id });
      await this.queue.addPollPosts({ channelId: ch.id });
    }
    if (due.length) this.logger.debug(`tier ${tier}: enqueued ${due.length} channels`);
  }

  private enabled(): boolean {
    return this.config.get<string>('TRACKING_ENABLED') === 'true';
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/automation/src/tracking/tracking.scheduler.ts
git commit -m "feat(tracking): tier-aware scheduler (hot/warm/cold + daily recompute)"
```

---

## Task 18: Auth guard

**Files:**
- Create: `apps/automation/src/tracking/api/tracking-auth.guard.ts`

- [ ] **Step 1: Implement**

```ts
// apps/automation/src/tracking/api/tracking-auth.guard.ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TrackingAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const expected = this.config.get<string>('TRACKING_TOKEN') ?? '';
    if (!expected) return true; // dev mode — no token configured

    const req = ctx.switchToHttp().getRequest();
    const auth = req.headers['authorization'] ?? '';
    const got = typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '').trim() : '';
    if (got && got === expected) return true;

    throw new UnauthorizedException('Invalid or missing tracking token');
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/automation/src/tracking/api/tracking-auth.guard.ts
git commit -m "feat(tracking): bearer-token auth guard (Phase 1 stub)"
```

---

## Task 19: DTOs

**Files:**
- Create: `apps/automation/src/tracking/api/dto/add-channel.dto.ts`
- Create: `apps/automation/src/tracking/api/dto/tracked-channel.dto.ts`
- Create: `apps/automation/src/tracking/api/dto/tracked-post.dto.ts`
- Create: `apps/automation/src/tracking/api/dto/graph.dto.ts`

- [ ] **Step 1: Write DTOs**

```ts
// add-channel.dto.ts
import { IsString, Matches } from 'class-validator';
export class AddChannelDto {
  @IsString() @Matches(/^@?[A-Za-z][A-Za-z0-9_]{3,31}$/)
  username!: string;
}
```

```ts
// tracked-channel.dto.ts
export interface TrackedChannelDto {
  id: string;
  username: string | null;
  title: string | null;
  about: string | null;
  subsCount: number | null;
  isMine: boolean;
  isClosed: boolean;
  pollTier: 'hot' | 'warm' | 'cold';
  addedAt: string;
  lastPolledAt: string | null;
}
```

```ts
// tracked-post.dto.ts
import { AdRef } from '../../types';
export interface TrackedPostDto {
  id: string;
  channelId: string;
  tgMessageId: string;
  text: string | null;
  hasMedia: boolean;
  postedAt: string;
  views: number | null;
  forwards: number | null;
  reactionsTotal: number | null;
  commentsCount: number | null;
  adRefs: AdRef[] | null;
}
```

```ts
// graph.dto.ts
export interface GraphNodeDto { id: string; username: string | null; title: string | null; subs: number | null; isMine: boolean; }
export interface GraphEdgeDto { source: string; target: string | null; target_username: string; count: number; kind: string; last_seen: string; }
export interface GraphDto     { nodes: GraphNodeDto[]; edges: GraphEdgeDto[]; }
```

- [ ] **Step 2: Commit**

```bash
git add apps/automation/src/tracking/api/dto/
git commit -m "feat(tracking): API DTOs"
```

---

## Task 20: `TrackingService` (query layer)

**Files:**
- Create: `apps/automation/src/tracking/api/tracking.service.ts`

- [ ] **Step 1: Implement**

```ts
// apps/automation/src/tracking/api/tracking.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrackedChannelsRepository } from '../repositories/tracked-channels.repository';
import { TrackedPostsRepository } from '../repositories/tracked-posts.repository';
import { TrackedEdgesRepository } from '../repositories/tracked-edges.repository';
import { TrackingQueueService } from '../tracking-queue.service';
import { estimateRoi } from '../processors/roi-heuristic';
import { TrackedChannelDto } from './dto/tracked-channel.dto';
import { TrackedPostDto } from './dto/tracked-post.dto';
import { GraphDto } from './dto/graph.dto';
import { PollTier } from '../types';

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);

  constructor(
    private readonly config:   ConfigService,
    private readonly channels: TrackedChannelsRepository,
    private readonly posts:    TrackedPostsRepository,
    private readonly edges:    TrackedEdgesRepository,
    private readonly queue:    TrackingQueueService,
  ) {}

  async listChannels(filter: 'mine' | 'all' | 'external', q: string | undefined,
                     tier: PollTier | undefined, page: number, pageSize: number) {
    const isMine = filter === 'mine' ? true : filter === 'external' ? false : undefined;
    const offset = (page - 1) * pageSize;
    const res = await this.channels.list({ is_mine: isMine, tier, q, limit: pageSize, offset });
    return { items: res.items.map((c) => this.toDto(c)), total: res.total };
  }

  async getChannel(id: string): Promise<TrackedChannelDto> {
    const c = await this.channels.getById(id);
    if (!c) throw new NotFoundException(`Channel ${id} not found`);
    return this.toDto(c);
  }

  async addChannel(username: string): Promise<{ id: string; status: 'queued' | 'already_tracked' }> {
    const clean = username.replace(/^@/, '').toLowerCase();
    const existing = await this.channels.getByUsername(clean);
    if (existing) return { id: existing.id, status: 'already_tracked' };
    const id = await this.channels.upsertByUsername({ username: clean, pollTier: 'warm' });
    await this.queue.addPollMeta({ channelId: id });
    await this.queue.addPollPosts({ channelId: id });
    return { id, status: 'queued' };
  }

  async deleteChannel(id: string): Promise<void> { await this.channels.softDelete(id); }

  async listPosts(channelId: string, from: Date | null, to: Date | null, limit: number, offset: number):
    Promise<{ items: TrackedPostDto[]; total: number }> {
    const r = await this.posts.listByChannel(channelId, from, to, limit, offset);
    return {
      items: r.items.map((p) => ({
        id: p.id, channelId: p.channelId, tgMessageId: p.tgMessageId,
        text: p.text, hasMedia: p.hasMedia, postedAt: p.postedAt.toISOString(),
        views: p.views, forwards: p.forwards, reactionsTotal: p.reactionsTotal,
        commentsCount: p.commentsCount, adRefs: p.adRefs,
      })),
      total: r.total,
    };
  }

  async subsHistory(channelId: string, from: Date | null, to: Date | null) {
    const points = await this.channels.subsHistory(channelId, from, to);
    return { points: points.map((p) => ({ at: p.snapshotAt.toISOString(), subs: p.subsCount })) };
  }

  async topPosts(channelId: string, metric: 'views' | 'reactions' | 'forwards', limit: number) {
    const column = metric === 'reactions' ? 'reactions_total' : metric;
    const items = await this.posts.topByMetric(channelId, column as any, limit);
    return { items };
  }

  async graph(from: Date | null, to: Date | null, minWeight: number): Promise<GraphDto> {
    const edges = await this.edges.graph(from, to, minWeight);
    const nodeIds = new Set<string>();
    edges.forEach((e) => { nodeIds.add(e.source_channel_id); if (e.target_channel_id) nodeIds.add(e.target_channel_id); });

    const nodes = await Promise.all([...nodeIds].map(async (id) => {
      const c = await this.channels.getById(id);
      return c ? { id: c.id, username: c.username, title: c.title, subs: c.subsCount, isMine: c.isMine } : null;
    }));

    return {
      nodes: nodes.filter((n): n is NonNullable<typeof n> => n !== null),
      edges: edges.map((e) => ({
        source: e.source_channel_id,
        target: e.target_channel_id,
        target_username: e.target_username,
        count: e.ad_post_count,
        kind: e.target_kind,
        last_seen: e.last_seen_at.toISOString(),
      })),
    };
  }

  async roi(channelId: string) {
    const c = await this.channels.getById(channelId);
    if (!c) throw new NotFoundException(`Channel ${channelId} not found`);
    const stats = await this.posts.statsLast30Days(channelId);
    const daysHistory = Math.floor((Date.now() - c.addedAt.getTime()) / 86_400_000);
    return estimateRoi({
      avgViews: stats.avgViews, subs: c.subsCount ?? 0,
      engagementRate: stats.engagementRate, daysHistory, postsCount: stats.postsCount,
      viewToSubRate: parseFloat(this.config.get<string>('TRACKING_VIEW_TO_SUB_RATE') ?? '0.02'),
    });
  }

  async discovery() {
    const items = await this.channels.listDiscoveryCandidates();
    return {
      items: items.map((c) => ({
        id: c.id, username: c.username, isClosed: c.isClosed, addedAt: c.addedAt.toISOString(),
      })),
    };
  }

  private toDto(c: any): TrackedChannelDto {
    return {
      id: c.id, username: c.username, title: c.title, about: c.about,
      subsCount: c.subsCount, isMine: c.isMine, isClosed: c.isClosed,
      pollTier: c.pollTier, addedAt: c.addedAt.toISOString(),
      lastPolledAt: c.lastPolledAt ? c.lastPolledAt.toISOString() : null,
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/automation/src/tracking/api/tracking.service.ts
git commit -m "feat(tracking): TrackingService query layer with ROI + graph"
```

---

## Task 21: `TrackingController`

**Files:**
- Create: `apps/automation/src/tracking/api/tracking.controller.ts`

- [ ] **Step 1: Implement**

```ts
// apps/automation/src/tracking/api/tracking.controller.ts
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import { TrackingAuthGuard } from './tracking-auth.guard';
import { AddChannelDto } from './dto/add-channel.dto';
import { PollTier } from '../types';

@Controller('tracking')
@UseGuards(TrackingAuthGuard)
export class TrackingController {
  constructor(private readonly service: TrackingService) {}

  @Get('channels')
  list(
    @Query('filter') filter: 'mine' | 'all' | 'external' = 'all',
    @Query('q') q?: string,
    @Query('tier') tier?: PollTier,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '50',
  ) {
    return this.service.listChannels(filter, q, tier, parseInt(page, 10), parseInt(pageSize, 10));
  }

  @Post('channels')
  add(@Body() dto: AddChannelDto) { return this.service.addChannel(dto.username); }

  @Get('channels/:id')
  one(@Param('id', new ParseUUIDPipe()) id: string) { return this.service.getChannel(id); }

  @Delete('channels/:id')
  remove(@Param('id', new ParseUUIDPipe()) id: string) { return this.service.deleteChannel(id); }

  @Get('channels/:id/posts')
  posts(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('from') from?: string, @Query('to') to?: string,
    @Query('limit') limit = '50', @Query('offset') offset = '0',
  ) {
    return this.service.listPosts(id,
      from ? new Date(from) : null, to ? new Date(to) : null,
      parseInt(limit, 10), parseInt(offset, 10));
  }

  @Get('channels/:id/subs-history')
  subs(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('from') from?: string, @Query('to') to?: string,
  ) {
    return this.service.subsHistory(id, from ? new Date(from) : null, to ? new Date(to) : null);
  }

  @Get('channels/:id/top-posts')
  top(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('metric') metric: 'views' | 'reactions' | 'forwards' = 'views',
    @Query('limit') limit = '10',
  ) {
    return this.service.topPosts(id, metric, parseInt(limit, 10));
  }

  @Get('graph')
  graph(
    @Query('from') from?: string, @Query('to') to?: string,
    @Query('min_edge_weight') minWeight = '1',
  ) {
    return this.service.graph(
      from ? new Date(from) : null, to ? new Date(to) : null,
      parseInt(minWeight, 10),
    );
  }

  @Get('roi/:id')
  roi(@Param('id', new ParseUUIDPipe()) id: string) { return this.service.roi(id); }

  @Get('discovery')
  discovery() { return this.service.discovery(); }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/automation/src/tracking/api/tracking.controller.ts
git commit -m "feat(tracking): REST controller exposing 8 endpoints"
```

---

## Task 22: `TrackingModule` + wire into `AppModule`

**Files:**
- Create: `apps/automation/src/tracking/tracking.module.ts`
- Modify: `apps/automation/src/app.module.ts`

- [ ] **Step 1: Module definition**

```ts
// apps/automation/src/tracking/tracking.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { RedisProvider } from './redis.provider';
import { TrackingQueueService } from './tracking-queue.service';
import { TrackingMtprotoClient } from './mtproto/tracking-mtproto.client';
import { TrackedChannelsRepository } from './repositories/tracked-channels.repository';
import { TrackedPostsRepository } from './repositories/tracked-posts.repository';
import { TrackedEdgesRepository } from './repositories/tracked-edges.repository';
import { PollMetaWorker } from './workers/poll-meta.worker';
import { PollPostsWorker } from './workers/poll-posts.worker';
import { RefreshMetricsWorker } from './workers/refresh-metrics.worker';
import { ResolveDiscoveryWorker } from './workers/resolve-discovery.worker';
import { TrackingScheduler } from './tracking.scheduler';
import { TrackingService } from './api/tracking.service';
import { TrackingController } from './api/tracking.controller';
import { TrackingAuthGuard } from './api/tracking-auth.guard';

@Module({
  imports: [ConfigModule, ScheduleModule.forRoot()],
  controllers: [TrackingController],
  providers: [
    RedisProvider,
    TrackingQueueService,
    TrackingMtprotoClient,
    TrackedChannelsRepository,
    TrackedPostsRepository,
    TrackedEdgesRepository,
    PollMetaWorker,
    PollPostsWorker,
    RefreshMetricsWorker,
    ResolveDiscoveryWorker,
    TrackingScheduler,
    TrackingService,
    TrackingAuthGuard,
  ],
})
export class TrackingModule {}
```

- [ ] **Step 2: Register in `app.module.ts`**

Open `apps/automation/src/app.module.ts`, find the `imports:` array, add `TrackingModule`:

```ts
import { TrackingModule } from './tracking/tracking.module';
// ...
@Module({
  imports: [
    // existing modules...
    TrackingModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 3: Typecheck**

```bash
cd apps/automation && npx tsc --noEmit -p tsconfig.json
```

Expected: EXIT=0.

- [ ] **Step 4: Boot and verify**

```bash
pnpm run dev:automation
```

Expected log lines:
```
[InstanceLoader] TrackingModule dependencies initialized
[Redis] connected to redis://localhost:6379
[TrackingMtprotoClient] TrackingMtprotoClient ready (or disabled warning)
```

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/tracking/tracking.module.ts apps/automation/src/app.module.ts
git commit -m "feat(tracking): wire TrackingModule into AppModule"
```

---

## Task 23: Smoke test via curl

**Files:** (none — verification only)

- [ ] **Step 1: Add a channel**

```bash
TOKEN=$(grep TRACKING_TOKEN apps/automation/.env.example | cut -d= -f2)
curl -s -X POST http://localhost:3000/tracking/channels \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username":"durov"}'
```

Expected: `{"id":"<uuid>","status":"queued"}`.

- [ ] **Step 2: Verify polling kicked in**

Wait 1-2 minutes (BullMQ picks up immediately, MTProto answers within seconds). Check logs:
```
[PollMetaWorker] poll-meta ok: durov subs=...
[PollPostsWorker] poll-posts durov: N new posts
```

- [ ] **Step 3: Query the channel**

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/tracking/channels?filter=external&q=durov"
```

Expected: JSON with one item, `subsCount` non-null.

- [ ] **Step 4: Query posts**

```bash
ID=<uuid from step 1>
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/tracking/channels/$ID/posts?limit=10"
```

Expected: list of posts with `views`, `forwards`, etc.

- [ ] **Step 5: Query graph**

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/tracking/graph?min_edge_weight=1"
```

Expected: `{"nodes":[...],"edges":[...]}` — may be empty if no ad refs yet.

- [ ] **Step 6: Query ROI**

```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3000/tracking/roi/$ID"
```

Expected: `{"estimated_subs_per_ad":N,"confidence":"low|medium|high",...}`.

- [ ] **Step 7: Commit smoke-test log/notes (optional)**

If you logged the run, add it under `docs/superpowers/notes/tracking-phase1-smoke.md` and commit:

```bash
git add docs/superpowers/notes/tracking-phase1-smoke.md
git commit -m "docs(tracking): Phase 1 smoke test results"
```

---

## Task 24: Open PR

- [ ] **Step 1: Push branch and create PR**

```bash
git push -u origin feat/tracking-backend
gh pr create --title "feat(tracking): Phase 1 backend (polling, processors, REST API)" \
  --body "$(cat <<'EOF'
## Summary
- New `tracking/` module: BullMQ-driven MTProto poller for arbitrary Telegram channels
- 5 new Postgres tables (`tracked_*`) via migration `002_tracking.sql`
- 4 worker types: poll-meta, poll-posts, refresh-metrics, resolve-discovery
- Tier-aware scheduler (hot/warm/cold) with daily recompute
- Ad-link extractor (forwards, mentions, t.me/instagram/web URLs)
- REST API (8 endpoints) with bearer-token auth stub
- Heuristic ROI estimator (Phase 3 will replace with Claude)

## Test plan
- [ ] `docker compose up -d postgres redis`
- [ ] `pnpm run dev:automation` — migration auto-applies
- [ ] All processor unit tests pass: `npx tsx --test apps/automation/src/tracking/processors/*.test.ts`
- [ ] Smoke test via curl (Task 23) on a real public channel
- [ ] Verify no impact on existing strategies (cron triggers, publishes)

## Follow-ups
- Phase 2 (`feat/dashboard-mvp`): React UI consuming this API
- Phase 3 (`feat/graph-and-roi`): React Flow graph + AI ROI rewrite

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

---

## Self-review checklist (for the implementer to run at the end)

- [ ] All 24 tasks committed; each commit has a meaningful message
- [ ] `npx tsx --test apps/automation/src/tracking/processors/*.test.ts` passes
- [ ] `cd apps/automation && npx tsc --noEmit -p tsconfig.json` passes
- [ ] `pnpm run dev:automation` boots cleanly, registers `TrackingModule`
- [ ] Smoke test (Task 23) all 6 endpoints return expected shapes
- [ ] No regression in existing ai0-news / ua-news / pdr-quiz strategies
- [ ] Spec sections all have corresponding tasks (see mapping below)

### Spec → task mapping (for the self-review)

| Spec section | Tasks |
|--------------|-------|
| Architecture diagram | 1, 11, 12, 17, 22 |
| NestJS modules layout | 22 |
| `tracked_channels` table | 2, 7 |
| `tracked_subs_history` | 2, 7 (markPolled) |
| `tracked_posts` | 2, 8 |
| `tracked_post_metrics_history` | 2, 15 |
| `tracked_ad_edges` | 2, 9 |
| `ad_refs` JSONB shape | 3, 5 |
| Tier policy | 4, 17 |
| Ad-link extraction rules | 5 |
| Discovery flow | 16 |
| REST API surface | 21, 20 |
| Heuristic ROI formula | 6, 20 |
| Env vars | 1 |
| Error handling (FLOOD_WAIT etc.) | 10, 12 |
| Testing strategy | 4, 5, 6, 23 |
| Migration safety | 2 |
