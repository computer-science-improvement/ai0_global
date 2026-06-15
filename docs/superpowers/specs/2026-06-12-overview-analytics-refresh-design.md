# Overview Remake + Analytics Meta Toggle — Design

**Status:** approved (brainstorming) — 2026-06-12
**Branch:** `feat/dashboard-overview-analytics` (off `feat/meta-insights`)
**Builds on:** Phase A follower stats + Phase B insights (the Meta data layer + chart components already exist).

## Goal

Make the dashboard cross-platform: turn **Overview** into a Telegram + Meta command
center, and add a **Telegram | Meta** toggle to **Analytics** so Meta accounts get
the same charting Telegram channels already have. Reuse the existing chart
components and hooks; add exactly one small backend field.

## Architecture

The Meta follower/insight data is already exposed by hooks (`useMetaAccounts`,
`useMetaFollowerHistory`, `useMetaAccountInsights`) and chart components
(`SubsHistoryChart`, `MetaReachImpressionsChart`, `MetaProfileViewsChart`). This
work surfaces them on Overview + Analytics. The only backend addition is a
per-account 24h follower delta on the accounts list, so growth figures need no
extra round-trips.

## 1. Backend — `followers_delta_24h` on the accounts list

`GET /api/meta-accounts` (list) gains `followers_delta_24h: number | null` per
account. To avoid N+1, add a batch method to `MetaFollowerHistoryRepository`:

`delta24hByAccount(): Promise<Map<string, number | null>>` — one query computing,
per account, `latest_followers − (nearest snapshot ≥24h ago)`. The list handler
calls it once and maps the value onto each row.

This single field powers: per-account growth on Overview's Meta section and on the
`/connections/meta` cards, plus the Overview total Δ24h (summed client-side).

## 2. Overview — cross-platform command center (`routes/index.tsx`)

- **Headline cards (one row):**
  - **Subscribers** — Telegram total (`sum(channels.subsCount)`, existing).
  - **Meta followers** — `sum(metaAccounts.followers)`.
  - **Meta Δ24h** — `sum(metaAccounts.followers_delta_24h)`, tone up/down.
  - **Active strategies** — existing.
  - **Errors** — existing (`strategies` with `last_run.status === 'error'`; already
    includes native-Meta publish failures, which surface as strategy-run errors).
- **Telegram section:** a "Channels" count stat + the existing **Upcoming runs** and
  **Strategy status** panels (unchanged).
- **Meta section (new):** a compact account list — avatar, @username, platform icon,
  current followers, **Δ24h** badge — each row links to
  `/connections/meta/$accountId`. A header **Refresh** button reuses
  `useRefreshMetaStats()`. Empty state ("Connect a Meta account on the Meta page")
  when there are none; loading states while queries are pending.

Subtitle changes from "Telegram · publishing and status" to a cross-platform line.

## 3. Analytics — Telegram | Meta toggle (`routes/analytics.tsx`)

- A segmented **Telegram | Meta** control at the top (local state, defaults to
  `telegram`).
- **Telegram view:** unchanged — channel selector + Subscribers / Views / Engagement
  / ROI panels.
- **Meta view:** a **Meta-account selector** (active accounts from `useMetaAccounts`)
  driving three panels that reuse the detail page's components:
  - **Followers over time** — `SubsHistoryChart` fed by `useMetaFollowerHistory`
    (`points.map(p => ({ at: p.at, subs: p.followers }))`).
  - **Reach & impressions** — `MetaReachImpressionsChart` fed by `useMetaAccountInsights`.
  - **Profile views** — `MetaProfileViewsChart`.
  Same loading / empty / "Not available on Threads" handling as the detail page.
  Empty state when no Meta accounts exist.

## 4. Components / reuse

No new chart components — Analytics + Overview consume the existing ones. A small
shared empty-state helper may be extracted if duplication is meaningful, otherwise
inline. The Meta-account row on Overview mirrors the connections card minus the
management buttons.

## 5. Error / loading / empty states

Every data region handles three states: loading (muted placeholder), empty (a muted
"connect / no data" note), and populated. Threads metrics that are null render
"Not available on Threads" rather than an empty chart (already the detail-page
behavior).

## 6. Testing

- Backend: unit test for `delta24hByAccount` shape + the list response including
  `followers_delta_24h` (via the existing controller/repo test fakes).
- Dashboard (no unit runner): `tsc` + `vite build` + Cyrillic-free guard on touched
  files; visual validation in the live preview (Overview headline cards + Meta
  section render; Analytics toggle switches Telegram↔Meta views).

## Out of scope

New Telegram aggregate metrics (7-day posts/views) — would need new backend
endpoints; TikTok; per-post Meta metrics (Phase C); the existing ROI panel stays
Telegram-only.

## Cost / safety guard (standing)

Build + `tsc` + unit tests only. No automation restart, no live API calls from the
build, no publishing. The user performs restarts and live smoke tests.
