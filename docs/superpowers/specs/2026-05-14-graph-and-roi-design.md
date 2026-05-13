# Channel Graph + AI ROI (Phase 3) — Design

**Date:** 2026-05-14
**Status:** approved (continuation of Phases 1 + 2)
**Parent specs:** `2026-05-13-channel-tracking-platform-design.md`, `2026-05-13-dashboard-mvp-design.md`
**Implementation branch:** `feat/graph-and-roi`

## Goal

Two features:

1. **Graph view** — visualise the ad-link relationships between tracked channels.
   Channels = nodes. Ad references = edges, weighted and colour-coded by frequency.
   Filterable by date range. Click node → channel detail dialog with "open page" CTA.
   Click edge → side panel listing all ad-posts that produced this edge.
2. **AI ROI rewrite** — replace the Phase 1 heuristic with a Claude-driven analysis
   that looks at the source channel's recent posts + target channel's category +
   ad history, and returns a structured estimate with narrative + risks.

## Stack additions

### Frontend
- **`reactflow`** — battle-tested for node-edge canvases at this scale
- **`d3-force`** — layout via React Flow's `useReactFlow` + d3 (avoid `dagre` because
  this is non-hierarchical, undirected-ish data)

### Backend
- Reuse existing `ClaudeAgent` (already in `apps/automation/src/common/ai/`).
- Cache ROI results in a new table (`tracked_roi_cache`) to avoid re-computing
  Claude calls for every UI page-load.

## Backend changes

### Migration `003_roi_cache.sql`

```sql
CREATE TABLE IF NOT EXISTS tracked_roi_cache (
  channel_id            UUID PRIMARY KEY REFERENCES tracked_channels(id) ON DELETE CASCADE,
  estimated_subs_per_ad INT NOT NULL,
  confidence            TEXT NOT NULL,        -- 'low' | 'medium' | 'high'
  narrative             TEXT,                 -- human-readable summary
  risks                 JSONB,                -- string[]
  inputs                JSONB,                -- snapshot of inputs at compute time
  computed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  source                TEXT NOT NULL         -- 'heuristic' | 'claude'
);
```

### New `RoiAnalyzerService`

```
apps/automation/src/tracking/processors/
└── roi-analyzer.service.ts        # orchestrator: cache lookup → fresh compute → store
```

Flow:
1. `GET /tracking/roi/:id?fresh=false`:
   - Lookup `tracked_roi_cache` — if `computed_at > now() - 7d` and `?fresh` is not set, return it.
   - Otherwise: load source channel stats + last 30 days of posts + sample ad targets.
   - Build Claude prompt (see template below), single API call (`claude-haiku-4-5` for cost).
   - Parse JSON output, store in cache, return.
2. `?fresh=true` (UI "Recompute" button) bypasses cache.
3. If Claude fails: fall back to existing `estimateRoi` heuristic and persist with
   `source='heuristic'`. Never throw.

Prompt template (system message):

> You are estimating whether a Telegram channel is a good ad placement.
> Given the channel's recent post performance and content topics, output JSON:
> `{"estimated_subs_per_ad": int, "confidence": "low"|"medium"|"high",
>   "narrative": "1–2 sentence summary in Ukrainian",
>   "risks": ["short bullet 1", "short bullet 2"]}`
>
> Use these guardrails: estimated_subs_per_ad ≈ avg_views × engagement-rate-multiplier ×
> view-to-subscriber rate (0.005 floor, 0.05 ceiling). Cite specific numbers in the
> narrative. List concrete risks (low engagement, off-topic audience, declining subs, etc.)
> — NOT generic ones.

### Endpoint changes
`GET /tracking/roi/:id?fresh=false` — same path, augmented response shape:

```ts
{
  estimated_subs_per_ad: number,
  confidence: 'low' | 'medium' | 'high',
  narrative: string,        // empty if heuristic-only
  risks: string[],          // empty if heuristic-only
  source: 'heuristic' | 'claude',
  computed_at: string,      // ISO
  inputs: { avg_views: number, subs: number, engagement_rate: number }
}
```

Existing heuristic returned a subset of these fields; the dashboard already tolerates
the extras (it just doesn't render them yet).

### Graph endpoint — extend

`GET /tracking/graph` already exists from Phase 1. Add new query params:
- `from`, `to` — already exist
- `kind` — filter edges by `tg_channel|tg_user|instagram|web` (optional, multi-select via repeat)
- `include_mine` — boolean, default true; if false, drop edges where source is `is_mine`

Response shape stays the same — adding fields to existing node/edge structures:
- node gains `subs: number | null`, `category: string | null`
- edge gains `colorTier: 'green' | 'orange' | 'red'` (computed server-side from `count`)

Edge colour rule:
- `count == 1` → `green`
- `2 ≤ count ≤ 9` → `orange`
- `count ≥ 10` → `red`

## Frontend

### `apps/dashboard/src/routes/graph.tsx`
- Top bar: date range picker (`from`, `to`), kind filter chips (channel/user/web/insta),
  min-edge-weight slider (1–10), "Include my channels" toggle
- React Flow canvas, 80vh height
- Custom node component: shows channel title + sub count, "mine" badge
- Custom edge component: thickness scales with `count`, colour per `colorTier`
- Hover edge → tooltip with last_seen + count
- Click node → opens `ChannelDialog` (channel details — re-uses chart components from Phase 2)
- Click edge → opens `EdgePanel` (right-side drawer with all `tracked_posts` that have
  `ad_refs` containing this target)

Layout: use React Flow's built-in `useNodesState` + `useEdgesState`. Apply d3-force layout
once on mount (compute coordinates, then set as static positions). For ≤ 200 nodes the
layout cost is sub-second and avoids the perf hit of continuous force-simulation.

### `apps/dashboard/src/components/RoiPanel.tsx`
Used both on channel-detail page (Phase 2 placeholder) and inside the graph node dialog.
Renders:
- Big number: `estimated_subs_per_ad`
- Confidence pill
- Narrative paragraph
- Risks list
- "Recompute" button (calls `?fresh=true`)
- Tiny `Computed via <source> · <relative time>` footer

### New backend endpoint for edge ad-posts
`GET /tracking/edges/:sourceId/:targetUsername/posts` →
returns array of `tracked_posts` from the source channel whose `ad_refs` mention
`targetUsername`. Backed by a new repo method that uses the `GIN` index on `ad_refs`.

## Out of scope (deferred to Phase 4 or later)

- Real-time graph updates (WebSocket / SSE)
- Graph editing (rename, manual link, hide node)
- Bulk export (CSV / GEXF)
- Multi-tenant filtering by user

## Risks

| Risk | Mitigation |
|------|------------|
| Graph perf for 500+ nodes / 2000+ edges | Hard cap: only show edges with `count >= min_edge_weight`. Default `min_edge_weight=1`; users can raise to 3+ for big graphs. Test with synthetic 500-node fixture before declaring done. |
| Claude ROI cost | Cache 7-day TTL + `claude-haiku-4-5` cheap model. ~$0.001 per ROI compute. 500 channels × monthly recompute ≈ $0.50 / month. |
| Cache staleness when a channel suddenly drops in engagement | "Recompute" button + 7-day automatic expiry. |
| React Flow bundle size (~120 KB gzipped) | Acceptable. Only loads on `/graph` route via lazy import. |
| Edge-posts endpoint scanning entire `tracked_posts` table | GIN index `idx_tracked_posts_ad_refs` from Phase 1 covers this query. |

## Success criteria

- Graph renders 100 nodes / 300 edges within 2 seconds
- Edge colours match the tier (visible distinction green vs orange vs red)
- Clicking a node opens a dialog with channel detail (subs, charts)
- Clicking an edge opens a panel listing ad-posts; clicking a post → channel detail
- Date filter actually narrows edge set (verify with synthetic data spanning multiple weeks)
- AI ROI returns within 3 seconds (cold) or < 200 ms (cached)
- Heuristic fallback fires correctly when `ANTHROPIC_API_KEY` is empty
