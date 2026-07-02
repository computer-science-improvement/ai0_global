# Project hardening, graph rewrite, tracked-delete, design standardization

**Date:** 2026-07-02 · **Branch:** `feat/strategy-improvements`
**Basis:** full-project audit (6 parallel finders → adversarial verification of every
high/med claim → synthesis). Raw result: 18/18 bug candidates REFUTED, 5 low-severity
observations, design inventory across all routes/components.

## Audit verdict (headline)

- **0 confirmed behavior bugs** across backend, API contract, frontend, security,
  DB schema. The session's earlier fixes (graph N+1 + LIMIT, TOKEN_ENCRYPTION_KEY 503,
  boot ordering, auth-guard wiring, strategy-run timeout) closed everything the
  finders could substantiate.
- **Design: no major drift.** 5 files carried one legacy pattern (`.chip chip-*`
  instead of `<Badge tone>`) + 1 hard-coded hex. The canonical contract is
  documented in `apps/dashboard/CLAUDE.md` (tables via `ui/table.tsx`, Badge
  statuses, `ACTION` icon vocabulary, primitives, CSS variables) and now also
  covers the card-row list pattern.

## Task 1 — Graph page: canvas renderer (freeze fix) ✅ done

**Root cause of the hang:** reactflow renders every node as a DOM component and
every edge as an SVG path; past a few hundred elements, layout+paint freezes the
tab. Backend limits (added earlier: batched `getByIds`, `ORDER BY ad_post_count
DESC LIMIT 2000`) cap the payload, but 2000 edges of DOM/SVG is still a freeze.

**Fix:** `force-graph` (single-canvas 2D renderer, d3-force physics).
- `components/GraphCanvas.tsx` rewritten: one `<canvas>`; nodes drawn as circles
  (size ~ log(subs), accent = mine, dashed ghost = external target), tier-colored
  links (green/orange/red = ad_post_count), dashed external edges, arrows,
  hover tooltips, zoom-gated labels (node names at scale>0.9, edge counts at
  scale>1.4), click → ChannelDialog / EdgePanel unchanged.
- Layouts: **Force** (default), **Tree ↓ / Tree →** (force-graph `dagMode`;
  cycles auto-fall back to Force via `onDagError`).
- Big-graph mode (>600 elements): synchronous `warmupTicks(120)` + static render
  (no wobble), `zoomToFit` on settle.
- Removed: `reactflow`, `@dagrejs/dagre`, `d3-force` deps; `ChannelNode.tsx`,
  `ExternalNode.tsx`, `lib/graph-layout.ts`.
- DEV perf harness: `/app/graph?synthetic=N` (`lib/graph-synthetic.ts`,
  dead-code-eliminated in prod builds).

**Measured (dev build, M-series):** 2 000 edges/666 nodes → median frame 8.3 ms;
**10 000 edges/3 333 nodes → median 8.3 ms, max 9.3 ms** (previously: full freeze).

## Task 2 — Delete tracked channels ✅ done

Backend already had `DELETE /tracking/channels/:id` (auth-guarded); the UI never
exposed it. Added:
- `ChannelRow` — optional `onDelete` prop → danger trash `btn-act` (stops the
  row-link navigation).
- `app.tracked.tsx` — `useConfirm()` dialog naming the channel and what gets
  dropped; mutation invalidates `['channels']` + `['graph']`; inline error card
  on failure.
- Repo method renamed `softDelete` → `hardDelete` (it hard-deletes; name lied),
  cascade behavior documented at the call site.

**Cascade verified against live schema** (transactional test, rolled back):
posts CASCADE, subs-history CASCADE, edges-from CASCADE, edges-into → SET NULL
(edge survives as unresolved external ref — ad-network history preserved).

## Task 3 — Design standardization ✅ done

Contract (per `apps/dashboard/CLAUDE.md` + card-row addendum):
- statuses ALWAYS `<Badge tone>`; actions ALWAYS `TableAction`/`ACTION` vocabulary
  (icon-only, danger separated); primitives from `ui/`; CSS variables only.

Fixed the 5 drifting files + 1 hex:
1. `routes/app.scheduled.tsx` — status chip map → `Badge` (reuses `STATUS_TONE`).
2. `components/ChannelRow.tsx` — mine/closed/paused chips → `Badge`.
3. `routes/app.channels_.$id.tsx` — paused/not-subscribed chips → `Badge`.
4. `routes/app.connections_.meta_.$accountId.tsx` — `CHIP_CLASS` map + 3 literal
   chips → `Badge`.
5. `routes/app.strategies_.$id.tsx` — enabled/last-run chips → `Badge`.
6. `routes/app.settings.tsx` — Toggle knob `#fff` → `var(--color-ink)`.

## Task 4 — Low-severity fixes (3 real of 5 reported) ✅ done

| Claim | Verdict | Action |
|---|---|---|
| image-resolver unguarded `JSON.parse` | **refuted** — already in try/catch | none |
| scheduler fire-and-forget async in cron | **refuted** — `reconcile()` is sync | none |
| PostComposer effect clobbers edits on refetch | real | dep `[editing]` → `[editing?.id]` |
| `as any` nav cast in RecommendationsTable | real | typed `navigate({to, params})` |
| `/trigger/:type` unauthenticated on dev-stage | real | `@UseGuards(TrackingAuthGuard)` (+ provider in AppModule); `/health` stays public. Verified live: 401 without token |

## Remaining / follow-ups (not blocking)

- [ ] Owner spot-check of the delete button flow in an authed session (I don't
      enter TRACKING_TOKEN; endpoint, cascade, build and UI wiring all verified).
- [ ] Bundle is 1.3 MB minified (warning) — code-split heavy routes (recharts,
      force-graph) via dynamic import when convenient.
- [ ] 124 Dependabot alerts on the repo (52 high) — separate dependency-upgrade
      pass.
- [ ] `ChannelRow` still uses neutral `.chip` for kind/bot tags (metadata tags,
      not statuses) — acceptable per contract; revisit if Badge grows a "tag"
      variant.

## Verification (all green)

- `apps/automation`: `npm run build` + `npm test` → **602/602**.
- `pnpm --filter dashboard build` → clean (tsc + vite).
- Graph perf: synthetic 2k / 10k — see numbers above; console error-free;
  Tree toggle doesn't freeze (cycle → force fallback).
- Cascade SQL proof + 401 guard checks against the live local stack.
