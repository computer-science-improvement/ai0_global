# Discovery & Growth Recommendations — Phase 4 MVP

**Date:** 2026-05-20
**Status:** approved (brainstorm phase) — pending implementation plan
**Branch:** `feat/graph-and-roi` (built on Phases 1-3 of channel-tracking-platform)
**Predecessors:**
- `2026-05-13-channel-tracking-platform-design.md` (overall platform)
- `2026-05-13-dashboard-mvp-design.md` (Phase 2)
- `2026-05-14-graph-and-roi-design.md` (Phase 3)

## Goal

Help the operator decide where to spend their ad-buy budget to grow a specific
owned Telegram channel. The operator picks one of their tracked channels as a
**target**, enters a budget, and the platform returns a ranked list of
**candidate channels** to advertise on — drawn from the TeleAds catalog,
filtered by budget, scored by theme overlap with the target plus any cached ROI
the platform already knows about.

Replaces ad-hoc browsing of [teleads.com.ua/catalog/channels](https://teleads.com.ua/catalog/channels)
+ manual cross-reference with Phase 3's ROI graph.

## Non-goals (deferred to later phases)

- **TG supergroup proposal listener** — Phase 4b. Listening to MTProto chat
  messages for ad-sale offers in private groups. Different ingestion mechanism,
  different parsing, lots of edge cases. Out of MVP.
- **Knapsack / multi-pick budget optimizer** — the MVP returns a *ranked list*
  with prices; the operator picks one or several manually. A real "given $X
  spend optimally across N channels" optimizer is Phase 4c.
- **AI-narrated rationale per recommendation** — Phase 3 already has the
  RoiAnalyzer for narrating ROI; reusing it for recommendations is out of MVP.
- **Auto-track-on-click** — clicking "Track this channel" in the UI currently
  just copies the t.me link; auto-pushing into the tracking pipeline is a
  later convenience.
- **Gender / location hard filters** — the data is captured (TeleAds returns
  `sex_ratio` and city-tagged categories), but no filter UI is wired in MVP.
- **Custom theme taxonomy** — we use TeleAds' category slugs as-is. Adding a
  parallel internal taxonomy is out of MVP.

## TeleAds API surface (verified open)

`https://teleads.com.ua` exposes a public REST API used by their own SPA. No
auth required for catalog browsing. Verified endpoints:

### Categories — `GET /api/promo/categories/?type=product&status=enabled`

Returns ~75 enabled categories with stable integer IDs and slug. Examples:

| id | slug | title |
|---|---|---|
| 16 | `znamenitosti` | Нейромережі |
| 19 | `internet-texnologiyi` | IT та програмування |
| 30 | `motivaciya-i-samorozvitok` | Психологія та Мотивація |
| 56 | `tsutatu` | Цитати |
| 64 | `igri-ta-mobail` | Ігри та Мобайл |
| 69 | `kyiv` | Київ (geo-tagged categories also live here) |

The full list is used as the theme vocabulary.

### Products — `GET /api/promo/products/`

Returns paginated channels. Query parameters observed:

- `status=enabled` (recommended)
- `page=N`, `per_page=N` (default 12, can request up to ~50 safely)
- `filter=categories:<id>;` — semicolon-separated id list
- `sorting=reviews_count-desc` and similar Laravel-style sort keys

Pagination follows Laravel API-Resource shape:

```json
{
  "data": [ /* products */ ],
  "links": { "first": "...", "last": "...", "next": "...", "prev": null },
  "meta": { "current_page": 1, "last_page": 1386, "total": 1386, "per_page": "1" }
}
```

Total enabled products: **1,386** (sampled 2026-05-20). With `per_page=100`,
the daily ingestion is ~14 HTTP calls.

### Product shape (fields we keep)

```jsonc
{
  "id": 1179,                          // external_id
  "slug": "truexanewsua",
  "link": "https://t.me/truexanewsua",
  "title": "Труха⚡️Україна",
  "description": "⚡️Актуальні події України.",
  "language": "ukrainian",
  "sex": "enabled",
  "sex_ratio": 53,                     // % female 0-100; null when sex="disabled"
  "prices": [
    { "type": "1day", "price": 80000 } // price in kopecks (UAH × 100)
  ],
  "categories": [
    { "id": 34, "slug": "novini-i-zmi", "title": "Новини і ЗМІ" }
  ],
  "avatar": { "media": { "sizes": { "320x320": { "url": "..." } } } }
}
```

Anything else lives in `raw_payload` so we can mine it later without
re-ingesting.

## Data model

### New table: `candidate_channels`

```sql
CREATE TABLE candidate_channels (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source        TEXT NOT NULL,             -- 'teleads' (Phase 4b adds 'supergroup_<id>', 'manual')
  external_id   TEXT NOT NULL,             -- TeleAds product.id as string
  slug          TEXT NOT NULL,             -- t.me/<slug>
  link          TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  language      TEXT,
  themes        TEXT[] NOT NULL DEFAULT '{}', -- TeleAds category slugs
  sex_ratio     INTEGER,                   -- 0-100; NULL when unknown
  price_min     INTEGER,                   -- kopecks; min across price-tier types
  price_max     INTEGER,
  avatar_url    TEXT,                      -- 320x320 if available
  raw_payload   JSONB NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);

CREATE INDEX idx_candidate_channels_themes  ON candidate_channels USING GIN (themes);
CREATE INDEX idx_candidate_channels_slug    ON candidate_channels (slug);
CREATE INDEX idx_candidate_channels_price   ON candidate_channels (price_min);
```

### Extend: `tracked_channels.themes`

```sql
ALTER TABLE tracked_channels
  ADD COLUMN IF NOT EXISTS themes TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_tracked_channels_themes
  ON tracked_channels USING GIN (themes);
```

Themes mirror TeleAds category slugs — same vocabulary so cross-matching is
trivial.

### Migration file

```
database/migrations/004_discovery.sql
```

Idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).

## Backend (NestJS)

### New module `apps/automation/src/discovery/`

```
discovery/
├── discovery.module.ts
├── teleads/
│   ├── teleads.client.ts                 // HTTP wrapper over teleads.com.ua/api
│   ├── teleads.client.test.ts
│   ├── teleads-ingestion.worker.ts       // daily cron
│   └── teleads-mapper.ts                 // product JSON → CandidateChannel row
├── repositories/
│   ├── candidate-channels.repository.ts
│   └── channel-themes.repository.ts      // queries/updates on tracked_channels.themes
├── recommendations/
│   ├── recommendations.service.ts        // scoring + ranking
│   ├── recommendations.service.test.ts   // pure-function unit tests on score()
│   └── recommendations.types.ts          // RecommendationItem DTO
└── api/
    ├── discovery.controller.ts           // /themes, /tracked-channels/:id/themes, /recommendations
    └── dto/
        ├── recommendations.dto.ts
        └── themes.dto.ts
```

### TeleAds client

Single class wrapping axios with TeleAds base URL. One method:

```ts
async listProducts(opts: {
  page?: number;
  perPage?: number;
  categories?: number[];   // category IDs for server-side filter
  sort?: string;
}): Promise<TeleAdsPage>;
```

Plus:

```ts
async listCategories(): Promise<TeleAdsCategory[]>;
```

Cached in-process for 24h since category list is stable.

Error handling: 429 / 5xx → exponential backoff + retry up to 3x. All
failures swallowed and logged — ingestion worker continues to the next page.

### Ingestion worker

```ts
@Injectable()
export class TeleAdsIngestionWorker {
  // BullMQ-driven daily cron (existing tracking-backend infra)
  // Or NestJS @Cron('0 4 * * *')  // 04:00 UTC = quiet hour
  async ingest(): Promise<{ inserted: number; updated: number; total: number }>;
}
```

Algorithm:
1. `listProducts({ page: 1, perPage: 100, status: 'enabled' })` → read `meta.last_page`
2. Sequentially fetch pages 1..last_page (no parallelism — TeleAds is a small
   site, be polite). 14 calls @ 100/page.
3. For each product: `teleadsMapper.toRow(product)` → upsert into
   `candidate_channels` using `ON CONFLICT (source, external_id) DO UPDATE`,
   bumping `last_seen_at`.
4. Stats logged at end.

Optional secondary step: candidates not seen in this run get their
`last_seen_at` left alone (no soft-delete in MVP — TeleAds may temporarily
hide a channel).

### Recommendations service

Pure-function scoring (MVP — single metric, ROI used as tie-breaker / display
only, not blended into the score because Phase 3's ROI metric is
`estimated_subs_per_ad INT` rather than a normalised 0..1 value):

```ts
function score(target: TrackedChannel, candidate: CandidateChannel): number {
  return jaccardSimilarity(target.themes, candidate.themes);  // 0..1
}
```

Where `jaccardSimilarity(a, b) = |a ∩ b| / |a ∪ b|` over the theme arrays,
both ends. Returns 0 if either side is empty.

Ranking order (descending priority):

1. `score` desc (theme overlap)
2. `estimated_subs_per_ad` desc (ROI from Phase 3 cache, when available;
   nulls last)
3. `price_min` asc (cheaper wins on ties)

Recommendation pipeline:

```ts
async recommend(input: {
  targetChannelId: string;
  budget: number;          // kopecks
  limit?: number;          // default 20
  excludeAlreadyTracked?: boolean;  // default true — skip channels we own
}): Promise<RecommendationItem[]>;
```

SQL (joins follow the real schemas — `tracked_channels.username` matches
`candidate_channels.slug`, `tracked_roi_cache.channel_id` is the FK):

```sql
SELECT
  c.*,
  r.estimated_subs_per_ad,
  r.confidence       AS roi_confidence,
  r.narrative        AS roi_narrative
FROM candidate_channels c
LEFT JOIN tracked_channels tc
       ON LOWER(tc.username) = LOWER(c.slug)
LEFT JOIN tracked_roi_cache r
       ON r.channel_id = tc.id
WHERE c.price_min IS NOT NULL
  AND c.price_min <= $budget
  AND c.themes && $target_themes::text[]   -- at least 1 theme overlap (GIN index)
  AND ($excludeAlreadyTracked = false
       OR tc.id IS NULL
       OR tc.is_mine = false)              -- only exclude channels we OWN, not ones we just track
LIMIT 500;
```

We pull up to 500 rows that pass the cheap SQL pre-filter (theme overlap +
budget), then compute the exact Jaccard score and final ranking in the app
layer where the weighted blend / tie-breaker logic is easier to read and
test. With ~1,386 enabled candidates and theme + budget filters, 500 is a
comfortable upper bound.

### Endpoints — `discovery.controller.ts`

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| `GET`  | `/api/themes` | — | `[{ slug, title }]` — full TeleAds category list, cached |
| `GET`  | `/api/tracked-channels/:id/themes` | — | `{ themes: string[] }` |
| `PUT`  | `/api/tracked-channels/:id/themes` | `{ themes: string[] }` | `204` |
| `POST` | `/api/recommendations` | `{ targetChannelId, budget, limit?, excludeAlreadyTracked? }` | `{ recommendations: RecommendationItem[], targetThemes: string[] }` |

`RecommendationItem`:

```ts
{
  id:                  string;
  slug:                string;
  link:                string;
  title:               string;
  description:         string | null;
  themes:              string[];
  matchedThemes:       string[];          // intersection with target
  score:               number;            // Jaccard similarity, 0..1
  estimatedSubsPerAd:  number | null;     // from tracked_roi_cache; null if not tracked or no ROI
  roiConfidence:       string | null;     // from tracked_roi_cache
  priceMin:            number;            // kopecks
  priceMax:            number;
  sexRatio:            number | null;
  avatarUrl:           string | null;
  language:            string | null;
  source:              "teleads";
}
```

All endpoints are guarded by the existing `TrackingAuthGuard` (cookie JWT
from Phase 2 auth).

## Frontend (`apps/dashboard`)

### New route — `/recommendations`

```
apps/dashboard/src/routes/recommendations.tsx
```

Wired into `routeTree.gen.ts` (auto-regenerated by TanStack Router).

Layout (top-down):

```
┌────────────────────────────────────────────────────────────────┐
│  Recommendations                                                │
│  ┌─────────────────────────┐  ┌──────────────────┐ ┌────────┐  │
│  │ Target channel ▼ (own)  │  │ Budget: 500 UAH  │ │ Search │  │
│  └─────────────────────────┘  └──────────────────┘ └────────┘  │
│  Target themes: [motivation] [quotes] [psychology]              │
├────────────────────────────────────────────────────────────────┤
│  #  Channel           Themes (matched bold)   Price   Subs/ad  ↗ │
│  1  @somechannel      motiv, psycho, quotes   200 ₴     +42     ↗ │
│  2  @another          motiv, quotes           150 ₴     —       ↗ │
│  ...                                                            │
└────────────────────────────────────────────────────────────────┘
```

Components:
- `<TargetChannelPicker />` — dropdown of `tracked_channels` where
  `is_mine = true` (re-use existing `useChannelsQuery({ mine: true })`)
- `<BudgetInput />` — UAH (number), converts to kopecks on submit
- `<RecommendationsTable />` — sortable table with score / price / ROI columns
- "Edit themes" inline button next to target channel name → opens modal

### `<EditThemesModal />`

Triggered from channel detail page (`/channels/$id`) AND from the
recommendations page (next to target picker). Reuses the same component.

```
┌──────────────────────────────────────┐
│  Edit themes — @your_channel         │
│  ┌────────────────────────────────┐  │
│  │ □ Психологія та Мотивація       │  │ ← multi-select
│  │ ☑ Цитати                        │  │   from /api/themes
│  │ ☑ Пізнавальні                   │  │
│  │ □ Ігри та Мобайл                │  │
│  │ ...                             │  │
│  └────────────────────────────────┘  │
│  [Cancel]                  [Save]    │
└──────────────────────────────────────┘
```

PUTs the new array on save → invalidates the recommendations query.

### Data flow

- `useThemes()` — react-query, GET `/api/themes`, infinite stale time
- `useChannelThemes(channelId)` — GET `/api/tracked-channels/:id/themes`
- `useUpdateChannelThemes()` — mutation PUT, invalidates channel + recs
- `useRecommendations({ targetId, budget })` — POST, returns array

All hooks live in `apps/dashboard/src/api/discovery.ts`.

### UI library — match existing style

`feat/graph-and-roi` uses Framer-style tokens (DESIGN.md). The new page must
look at home with `/channels` and `/graph`. Same pill buttons, same canvas
tokens. Re-use `<Pagination />`, `<Layout />`, `<ChannelRow />` where it
fits.

## Error handling

| Failure | Behaviour |
|---|---|
| TeleAds 429 / 5xx during ingestion | Exponential backoff up to 3 retries per page. Skip-and-continue if all fail. Log error. |
| TeleAds returns malformed product | Log warning, skip that product, continue. |
| Recommendations called with `targetChannelId` not in tracked_channels | 404 |
| Recommendations called with empty target.themes | Return empty list + warning in response body (`{ recommendations: [], warning: "Set themes for target first" }`) |
| Update themes with category slug not in `/api/themes` | 400 (validate against cached category list) |
| Frontend recs query while target has no themes | Inline empty-state with CTA "Edit themes" |

## Testing

### Unit tests (Vitest / Jest — match existing setup)

- `recommendations.service.test.ts` — `score()` math, Jaccard edge cases (empty arrays, identical arrays, zero overlap)
- `teleads-mapper.test.ts` — product JSON → row mapping, especially price normalisation, missing avatar, missing sex_ratio
- `candidate-channels.repository.test.ts` — upsert idempotency

### Integration test

One e2e test:
1. Stub TeleAds with 5-product fixture
2. Run ingestion worker
3. Set themes on a test tracked_channel
4. Call `/api/recommendations` with that channel id and a large budget
5. Assert: returned items have matched themes; order matches expected score

Stub via msw or a fixture-server.

### Manual smoke test post-deploy

1. Open dashboard
2. Set themes on `@motivation_local` (test channel)
3. Open `/recommendations`, pick that channel as target, budget 1000 UAH
4. Expect: list of motivation-themed candidates from TeleAds

## Operational concerns

- **Ingestion cadence**: daily at 04:00 UTC. Idempotent upserts mean re-running
  is safe.
- **Rate limit**: TeleAds returned 200 on all probes; no documented limit.
  Be polite: serial, 200ms delay between pages.
- **Storage**: 1,386 rows × ~3 KB raw_payload each = ~4 MB. Negligible.
- **Cache**: `/api/themes` cached in-process for 24h (category list is stable).
- **Auth**: existing Phase 2 cookie-JWT covers all new endpoints. No new auth.
- **Backwards compat**: `tracked_channels.themes` defaults to `'{}'` — existing
  rows continue to work, no recommendations until user sets themes.

## Open questions resolved during brainstorm

1. **Q: Decomposition** → MVP in one PR (this spec). Supergroup listener +
   knapsack optimizer + gender/location filters split to Phase 4b/4c.
2. **Q: Recommendation input** → 1 target + budget.
3. **Q: Theme source** → store in DB, edit via UI. Vocabulary = TeleAds
   category slugs.
4. **Q: TeleAds access** → public API confirmed; no auth needed.
5. **Q: Custom themes** → not in MVP — use TeleAds list verbatim.

## Implementation phases inside this PR

1. **DB migration** (small, low-risk) — `004_discovery.sql`
2. **TeleAds client + mapper + ingestion worker** (backend, no UI yet) —
   verifiable via SQL after one manual cron fire
3. **Repositories + recommendations service** with unit tests
4. **REST endpoints** + DTOs + guards
5. **Frontend hooks** (`api/discovery.ts`)
6. **`<EditThemesModal />`** + integration into channel detail page
7. **`/recommendations` route** with full table
8. **Smoke test on dev**

Linear order. Each step adds something queryable / clickable. The order in
the implementation plan will match.

## Out of scope (next phases)

- **4b**: TG supergroup listener — MTProto-based polling of an admin chat,
  message parser, candidate extraction from natural-language ads.
- **4c**: Budget-aware knapsack — "given $X, give me the optimal mix of N
  channels" instead of a sorted list.
- **4d**: Gender / location hard filters in the UI.
- **4e**: AI-narrated rationale per recommendation (reuse Phase 3 RoiAnalyzer
  pattern).
- **4f**: Auto-track-on-click — clicking a recommendation pushes the slug
  into `tracked_channels` and enqueues a poll-meta job.
