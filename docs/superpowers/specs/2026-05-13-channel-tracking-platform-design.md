# Channel Tracking & Analytics Platform — Design

**Date:** 2026-05-13
**Status:** approved (brainstorm phase)
**Implementation phases:** 3 (separate specs + PRs)
**This spec covers:** overall architecture + Phase 1 detail; Phase 2 and 3 are high-level only.

## Goal

Track an arbitrary, growable set of Telegram channels (target scale 500+) — capture every
post, every metric snapshot, every advertised link to another channel. Surface the data
via a React dashboard with channel-level analytics, an ad-relationship graph, and an
AI-narrated ROI estimate for ad placements.

Replace ad-hoc TGStat / Telemetrio lookups for the operator's media-buying decisions
with first-party, full-history data the operator controls.

## Non-goals

- **Not a public SaaS.** Auth gates the dashboard; data is private.
- **Not a content-moderation tool.** We capture posts as-is, no NSFW / spam filtering.
- **Not real-time chat.** Polling is acceptable; we don't subscribe to live updates in
  Phase 1 (revisit in Phase 4 if rate-limits push us there).
- **Instagram metrics out of scope.** We capture Instagram-link mentions for graph
  edges only; we don't scrape Instagram itself.

## Decomposition

| Phase | Branch | Scope |
|-------|--------|-------|
| **1** | `feat/tracking-backend` | Polling, processors, ad-edge extraction, REST API, DB migrations. Backend-only; testable via curl. |
| **2** | `feat/dashboard-mvp` | `apps/dashboard` (Vite + React). Channel list, channel detail (charts), manual-add modal. Telegram Login auth. |
| **3** | `feat/graph-and-roi` | Graph page (React Flow), date filters, edge-color heuristic. AI-narrated ROI analyzer (Claude). |

Each phase is an independent spec → plan → PR. Phase 1 is fully detailed below; 2 and 3
are described only enough to ensure Phase 1's data model and API surface support them.

---

## Phase 1 — Tracking backend

### Architecture

```
              cron (existing SchedulerService)
                │
                ▼
     ┌──────────────────────┐
     │ TrackingScheduler    │  tiered: hot / warm / cold
     │ (every 1 min)        │
     └────────┬─────────────┘
              │ enqueue jobs (poll-meta, poll-posts, refresh-metrics, resolve-discovery)
              ▼
     ┌──────────────────────┐
     │ BullMQ (Redis 7)     │  4 named queues
     └────────┬─────────────┘
              │
              ▼
     ┌──────────────────────┐    ┌────────────────────────┐
     │ Worker pool          │───▶│ MTProto session pool   │  extends TelegramStatsClient
     │ (BullMQ workers)     │    │ (1 session for Phase 1)│
     └────────┬─────────────┘    └────────────────────────┘
              │
              ▼
     ┌────────────────────────────────────────────────┐
     │ Processors (pure functions, unit-testable):    │
     │   • postExtractor     — post → entity row     │
     │   • metricsWriter     — snapshot delta logic  │
     │   • adRefExtractor    — text+entities → edges │
     │   • discoveryResolver — unknown @x → action   │
     └────────┬───────────────────────────────────────┘
              │
              ▼
          Postgres (existing)
              │
              ▼
        REST API (NestJS) — new TrackingApiModule
```

### Modules (NestJS)

```
apps/automation/src/tracking/
├── tracking.module.ts
├── tracking.scheduler.ts          // tier-aware cron
├── tracking-queue.service.ts      // BullMQ wrapper
├── workers/
│   ├── poll-meta.worker.ts
│   ├── poll-posts.worker.ts
│   ├── refresh-metrics.worker.ts
│   └── resolve-discovery.worker.ts
├── processors/
│   ├── post-extractor.ts
│   ├── post-extractor.test.ts
│   ├── ad-ref-extractor.ts
│   ├── ad-ref-extractor.test.ts
│   └── tier-classifier.ts
├── repositories/
│   ├── tracked-channels.repository.ts
│   ├── tracked-posts.repository.ts
│   └── tracked-edges.repository.ts
├── mtproto/
│   └── tracking-mtproto.client.ts  // extends existing TelegramStatsClient
└── api/
    ├── tracking.controller.ts
    ├── tracking.service.ts
    └── dto/
        ├── add-channel.dto.ts
        └── graph-query.dto.ts
```

### Data model

All tables prefixed `tracked_` to avoid clash with existing `published_posts`, `bot_logs`.

```sql
-- Channels we monitor (or are queued to monitor).
CREATE TABLE tracked_channels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tg_chat_id      BIGINT UNIQUE,                 -- nullable until first resolve
  username        TEXT,                          -- @handle, lowercased; nullable for private
  title           TEXT,
  about           TEXT,
  category        TEXT,                          -- AI/manual, nullable
  is_mine         BOOLEAN NOT NULL DEFAULT FALSE,
  is_closed       BOOLEAN NOT NULL DEFAULT FALSE,
  poll_tier       TEXT NOT NULL DEFAULT 'warm',  -- 'hot' | 'warm' | 'cold'
  subs_count      INT,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_polled_at  TIMESTAMPTZ,
  meta            JSONB,                          -- raw GetFullChannel cache
  UNIQUE (username)
);
CREATE INDEX idx_tracked_channels_tier_polled ON tracked_channels (poll_tier, last_polled_at);
CREATE INDEX idx_tracked_channels_is_mine    ON tracked_channels (is_mine);

-- Time-series snapshot of subscriber counts.
CREATE TABLE tracked_subs_history (
  channel_id   UUID NOT NULL REFERENCES tracked_channels(id) ON DELETE CASCADE,
  snapshot_at  TIMESTAMPTZ NOT NULL,
  subs_count   INT NOT NULL,
  PRIMARY KEY (channel_id, snapshot_at)
);

-- One row per Telegram post seen.
CREATE TABLE tracked_posts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id       UUID NOT NULL REFERENCES tracked_channels(id) ON DELETE CASCADE,
  tg_message_id    BIGINT NOT NULL,
  text             TEXT,
  has_media        BOOLEAN NOT NULL DEFAULT FALSE,
  media_type       TEXT,                          -- 'photo' | 'video' | 'document' | null
  posted_at        TIMESTAMPTZ NOT NULL,
  views            INT,
  forwards         INT,
  reactions_total  INT,
  reactions        JSONB,                          -- {"❤️": 12, "🔥": 3, ...}
  comments_count   INT,
  ad_refs          JSONB,                          -- see below; nullable when none
  last_metrics_at  TIMESTAMPTZ,
  UNIQUE (channel_id, tg_message_id)
);
CREATE INDEX idx_tracked_posts_channel_posted ON tracked_posts (channel_id, posted_at DESC);
CREATE INDEX idx_tracked_posts_ad_refs ON tracked_posts USING GIN (ad_refs)
  WHERE ad_refs IS NOT NULL;

-- Optional per-post metrics history (only for posts the user marked or "top N" recent).
-- Phase 1 captures only the current snapshot in tracked_posts; this table is created but
-- written to only when refresh-metrics decides a post is worth time-series tracking.
CREATE TABLE tracked_post_metrics_history (
  post_id      UUID NOT NULL REFERENCES tracked_posts(id) ON DELETE CASCADE,
  snapshot_at  TIMESTAMPTZ NOT NULL,
  views        INT NOT NULL,
  forwards     INT NOT NULL,
  reactions    INT NOT NULL,
  comments     INT NOT NULL,
  PRIMARY KEY (post_id, snapshot_at)
);

-- Denormalized ad-edge aggregate. One row per (source, target_username).
CREATE TABLE tracked_ad_edges (
  source_channel_id  UUID NOT NULL REFERENCES tracked_channels(id) ON DELETE CASCADE,
  target_channel_id  UUID REFERENCES tracked_channels(id) ON DELETE SET NULL,
  target_username    TEXT NOT NULL,
  target_kind        TEXT NOT NULL,                -- 'tg_channel' | 'tg_user' | 'instagram' | 'web'
  ad_post_count      INT NOT NULL DEFAULT 1,
  first_seen_at      TIMESTAMPTZ NOT NULL,
  last_seen_at       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (source_channel_id, target_username, target_kind)
);
CREATE INDEX idx_tracked_ad_edges_target ON tracked_ad_edges (target_channel_id)
  WHERE target_channel_id IS NOT NULL;
```

`ad_refs` JSONB shape:

```json
[
  { "kind": "tg_channel", "username": "somenews", "target_post_id": 1234 },
  { "kind": "tg_channel", "username": "anotherchan", "forward": true },
  { "kind": "instagram",  "username": "brand.account" },
  { "kind": "web",        "domain": "example.com" }
]
```

### Polling strategy

Tiers control polling cadence. Job `recompute-tiers` runs once daily:

| Tier | Avg posts/day (over last 7 d) | Cadence |
|------|------------------------------|---------|
| hot  | ≥ 3                          | every 5 min |
| warm | 0.5 – 3                      | every 30 min |
| cold | < 0.5                        | every 6 h |

New channels start in `warm` until they have ≥ 3 days of data.

Per-channel rate-limit budget: max 1 `GetHistory` call per minute per channel. BullMQ
worker enforces `concurrency: 5` to stay well under MTProto's ~20 req/s per session.

### Ad-link extraction rules

`adRefExtractor(post)` returns an array. Sources, in order of precedence:

1. **Forwarded post** (`message.fwd_from.from_id`)
   → `{ kind: 'tg_channel'|'tg_user', username, forward: true }`
2. **Mention entities** (`MessageEntityMention`, `MessageEntityMentionName`)
   → `{ kind: 'tg_channel', username }`
3. **URL entities and text URLs**:
   - `t.me/<u>` or `t.me/<u>/<id>` → `{ kind: 'tg_channel', username: u, target_post_id: id? }`
   - `instagram.com/<u>` → `{ kind: 'instagram', username: u }`
   - other domains → `{ kind: 'web', domain }`
4. Deduplicate by `(kind, username|domain)` within one post.

`discoveryResolver` (separate worker, low priority):
- For each ad_ref with `kind='tg_channel'` and unknown `username`:
  - Call MTProto `contacts.ResolveUsername`
  - If success → INSERT into `tracked_channels` with `is_mine=false, poll_tier='cold'`,
    enqueue `poll-meta`
  - If `USERNAME_NOT_OCCUPIED` / `USERNAME_INVALID` → log and skip
  - If channel is private → INSERT with `is_closed=true, is_mine=false`, surface in
    `/tracking/discovery` endpoint (the dashboard renders this as "needs your manual
    join" tab in Phase 2)

### Discovery flow (closed channels)

```
tracked_posts INSERT ──▶ adRefExtractor ──▶ enqueue resolve-discovery
                                                       │
                                                       ▼
                                          ┌─────────────────────────┐
                                          │ ResolveUsername (MTProto)│
                                          └───────────┬─────────────┘
                                                      │
                          ┌───────────────────────────┴────────────┐
                          ▼                                          ▼
                  channel public                          channel private/closed
                  enqueue poll-meta                       INSERT is_closed=true
                  start tracking                          notify owner via admin-bot
```

### REST API (Phase 1)

```
GET    /tracking/channels?filter=mine|all|external&q=<text>&tier=<hot|warm|cold>
       &page=<n>&pageSize=<m>
       → { items: TrackedChannel[], total: number }

POST   /tracking/channels                                    -- enqueue manual add
       body: { username: "somechannel" }
       → { id: uuid, status: 'queued' | 'already_tracked' }

GET    /tracking/channels/:id
       → TrackedChannel + latest stats

DELETE /tracking/channels/:id                                -- soft-delete

GET    /tracking/channels/:id/posts?from=<iso>&to=<iso>&limit=<n>&offset=<m>
       → { items: TrackedPost[], total: number }

GET    /tracking/channels/:id/subs-history?from=<iso>&to=<iso>
       → { points: [{ at: iso, subs: int }] }

GET    /tracking/channels/:id/top-posts?metric=<views|reactions|forwards>&limit=10
       → { items: TrackedPost[] }

GET    /tracking/graph?from=<iso>&to=<iso>&min_edge_weight=<n>
       → { nodes: [{ id, username, title, subs, is_mine }],
           edges: [{ source, target, target_username, count, kind, last_seen }] }

GET    /tracking/roi/:id                                     -- Phase 1: heuristic
       → { estimated_subs_per_ad: number,
           confidence: 'low'|'medium'|'high',
           basis: 'avg_views/subs_ratio × N',
           inputs: { avg_views, subs, engagement_rate } }

GET    /tracking/discovery
       → { items: [{ id, username, first_seen_in, is_closed, reason }] }
```

All write endpoints (POST, DELETE) require auth — Phase 1 ships with a stub
`@RequireAuth()` guard that checks `X-Tracking-Token` header against env var. Phase 2
replaces it with Telegram-Login-derived JWT.

### Heuristic ROI formula (Phase 1)

```
avg_views     = mean(views) of last 30 days of posts
engagement    = mean(reactions+forwards+comments) / avg_views
subs          = current subs_count
view_to_sub   = empirical constant (start 0.02 = 2% of viewers in target
                                    audience may subscribe to an ad-target)
adjusted_rate = view_to_sub × engagement_multiplier
                where engagement_multiplier:
                  < 1%   engagement → 0.5
                  1–5%   engagement → 1.0
                  > 5%   engagement → 1.5

estimated_subs_per_ad = avg_views × adjusted_rate

confidence:
  high   if ≥ 30 days history AND ≥ 50 posts
  medium if ≥ 14 days history AND ≥ 20 posts
  low    otherwise
```

The constant `view_to_sub` is configurable (`TRACKING_VIEW_TO_SUB_RATE` env, default 0.02).
Phase 3 will replace this with Claude-driven analysis that adjusts based on topic overlap
between source and target channels.

### Configuration

New env vars:

```
REDIS_URL=redis://localhost:6379
TRACKING_ENABLED=true
TRACKING_POLL_INTERVAL_HOT_MIN=5
TRACKING_POLL_INTERVAL_WARM_MIN=30
TRACKING_POLL_INTERVAL_COLD_HOURS=6
TRACKING_VIEW_TO_SUB_RATE=0.02
TRACKING_TOKEN=<bearer for stub auth>      # Phase 1 only
```

Redis runs in the existing docker-compose alongside Postgres.

### Error handling

| Failure | Response |
|---------|----------|
| MTProto `FLOOD_WAIT_X` | Worker sleeps X seconds, job re-enqueues with delay. |
| `CHANNEL_PRIVATE` on poll | Mark `is_closed=true`, demote to `cold`. |
| Network timeout | Retry 3× with exponential backoff (BullMQ built-in). |
| `USERNAME_INVALID` during discovery | Log + skip; do not insert ghost row. |
| Postgres connection lost | BullMQ retries the job; no data loss. |
| Workers OOM-killed | docker-compose restarts; jobs resume from queue. |

### Testing

- **Unit** (Node's `node:test` + `tsx`): `postExtractor`, `adRefExtractor`,
  `tierClassifier`, ROI formula. All pure functions; no Postgres needed.
- **Integration**: One test that spins up Postgres + Redis in CI (docker compose),
  enqueues a synthetic `poll-posts` job with mocked MTProto, verifies tables.
- **Manual smoke**: curl against staging API for each endpoint after first deploy.

### Migration strategy

- New tables only; nothing modified on existing tables.
- Migration adds `gen_random_uuid()` via `pgcrypto` extension if not present.
- Rollback is a clean `DROP TABLE tracked_*` since no other code depends on them yet.
- Existing `TelegramStatsClient` stays unchanged; new `TrackingMtprotoClient` extends it.

---

## Phase 2 — Dashboard MVP (high-level only)

Stack: Vite 5 + React 18 + TanStack Router + TanStack Query + Tailwind + Recharts.

Pages:
- **/login** — Telegram Login Widget; on success POSTs to `/auth/telegram-login`,
  receives HttpOnly JWT cookie.
- **/channels** — paginated list, filter (mine/all/external), search by username.
- **/channels/:id** — sub-history chart, posts timeline (views × time), top posts grid.
- **/channels/:id/add** modal — username input + submit.
- **/discovery** — closed/unresolved channels list.

Deploy: new container `dashboard` (nginx + static build). Auth: backend issues JWT
with `tracking:read|write` claims; nginx proxies `/api` to NestJS.

## Phase 3 — Graph + AI ROI (high-level only)

- **/graph** page using React Flow.
  - Layout: force-directed (d3-force preset).
  - Nodes: channels (size by subs).
  - Edges: ad-counts; color: 1 = green, 2-4 = orange, 5-9 = orange-dark, 10+ = red.
  - Click node → channel detail dialog with "Open page" button.
  - Click edge → side panel listing all `tracked_posts` where edge was detected.
  - Date filter: top-bar range picker; updates `/tracking/graph?from=&to=` query.
- **AI ROI rewrite**: replace heuristic with Claude (sonnet, single API call):
  prompt = source channel posts (last 30 d) + target channel category + ad history.
  Output: structured `{ estimated_subs, confidence, narrative, risks: [] }`.

## Open questions for Phase 2/3

These do not block Phase 1 but should be answered before the corresponding phase:

1. **Phase 2:** session storage — JWT in cookie vs in localStorage? (Recommend cookie
   to mitigate XSS.)
2. **Phase 3:** graph max nodes before performance degrades — set hard cap (≤ 500 visible
   at once) and offer "expand neighborhood" interaction?
3. **Phase 3:** ROI for unsubscribed audience overlap — do we count target channel's own
   subs to estimate uniqueness? Requires extra MTProto calls.

## Risks

| Risk | Mitigation |
|------|------------|
| MTProto rate-limit ban on user account | Conservative concurrency (5), tier-based cadence, monitor FLOOD_WAIT frequency, plan for session pool in Phase 1.5 if needed. |
| Postgres growth: 500 channels × 100 posts/month × 12 mo = 600k rows | Acceptable; partition `tracked_post_metrics_history` by month if needed. |
| AI cost in Phase 3 for ROI on 500+ channels | Cache per (channel, week); only recompute when fresh post arrives or user manually requests. |
| Telegram-Login token replay | Verify hash + timestamp ≤ 1 day per Telegram docs. |
| Adding many private channels at once | Discovery worker has rate-limit on `ResolveUsername` (max 100/h). |

## Success criteria

- Track 50+ channels for 7 days with zero data-integrity bugs and < 5% missed posts vs
  manual spot-checks.
- Dashboard loads channel list in < 500 ms p95 with 500 channels.
- Graph page renders 500 nodes / 2000 edges in < 2 s.
- ROI estimate falls within ±30% of actual subscriber gain on 3 known historical ads.
