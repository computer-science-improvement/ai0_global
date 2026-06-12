# Meta Account Insights (Phase B) — Design

**Status:** approved (brainstorming) — 2026-06-12
**Branch:** `feat/meta-insights` (off `develop`, which already contains Phase A follower stats)
**Builds on:** Phase A (`meta_follower_history`, `MetaStatsCollectorService`, the Meta account detail page).

## Goal

Capture and chart **account-level daily insights** — reach, impressions, profile
views — per Meta account over time, surfaced as extra panels on the existing Meta
account detail page, mirroring how Telegram channel analytics extend the channel
detail page.

The app **already has the insights scopes approved** (`instagram_manage_insights`,
`read_insights`, `threads_manage_insights`), so this is built against live data —
not shipped dark. We still degrade gracefully per metric, because individual
metrics are version-dependent (e.g. IG `impressions` is deprecated in newer API
versions) and platforms differ in what they expose.

## Scope

Account-level daily metrics only: **reach, impressions, profile views**. Per-post
insights (likes/reach per published post), audience demographics, and follower
online-times are **out of scope** (Phase C+ — per-post needs media-id persistence
at publish time).

## Architecture

Mirror the Phase A pipeline: same collector loop, a parallel daily-insights table +
repository, an insights endpoint on the meta-accounts controller, and new chart
panels on the existing detail page. No new generic-metric abstraction (YAGNI for
three fixed metrics).

### 1. Data model — migration `022_meta_account_insights.sql`

Insights are **daily** values (`period=day`), so one row per account per day,
upserted idempotently (the current day's value firms up as it accrues):

```sql
CREATE TABLE meta_account_insights (
  id            BIGSERIAL PRIMARY KEY,
  account_id    UUID NOT NULL REFERENCES meta_accounts(id) ON DELETE CASCADE,
  day           DATE NOT NULL,
  reach         INT,
  impressions   INT,
  profile_views INT,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, day)
);
CREATE INDEX idx_meta_insights_account_day ON meta_account_insights (account_id, day DESC);
```

`reach`/`impressions`/`profile_views` are nullable — a platform that doesn't expose
a metric stores `null` for it.

### 2. Graph fetch — `MetaGraphClient.fetchInsights(platform, targetId, token, sinceDays)`

Returns a normalized `MetaInsightDay[]` = `{ day: string; reach: number|null;
impressions: number|null; profileViews: number|null }[]`, one per day in the window.

**Per-metric graceful**: if the API rejects a metric (deprecated/unsupported on
that platform+version), that metric is `null` for the affected days; the fetch as a
whole still succeeds. A whole-request failure (auth, network) throws and is isolated
per account by the collector.

Reuses the existing host/version helpers (`FACEBOOK_GRAPH` vs `THREADS_GRAPH`,
`graphVersion`/`threadsVersion`, `graphTimeout`, token-redacted errors).

**Endpoint + metric mapping** (normalized to one common set so the UI stays uniform):

| Normalized | Instagram (`/{id}/insights`) | Facebook (`/{page}/insights`) | Threads (`/{id}/threads_insights`) |
|---|---|---|---|
| `reach`         | `reach` (period=day)      | `page_impressions_unique` | `null` (no equivalent) |
| `impressions`   | `impressions` (best-effort; null if deprecated) | `page_impressions` | `views` |
| `profileViews`  | `profile_views`           | `page_views_total`        | `null` |

Notes:
- IG/FB use `period=day` with `since`/`until` (UNIX dates) spanning `sinceDays`.
- Threads uses `threads_insights` (its own host + version line, like the publisher).
- The mapping is documented in code next to `fetchInsights` so future metric churn
  has one place to change.

### 3. Collector — extend `MetaStatsCollectorService`

In the existing per-account loop (which already resolves the token + fetches
followers), after the follower snapshot, call `fetchInsights(...)` for the recent
window (default last **30** days) and `upsertDay(...)` each returned day. The
existing `running` guard and per-account `try/catch` isolation stay; an insights
failure for one account is logged and does not block the follower snapshot, other
metrics, or other accounts. `runOnce()`'s return is extended to
`{ accounts, snapshots, insightDays }`.

### 4. Repository + API

- **`MetaAccountInsightsRepository`**:
  - `upsertDay(accountId, day, { reach, impressions, profileViews })` — `INSERT … ON
    CONFLICT (account_id, day) DO UPDATE`.
  - `history(accountId, from?, to?)` → `MetaInsightDay[]` ordered by day asc.
- **API** (`meta-accounts.controller.ts`, same `TrackingAuthGuard` as the
  follower-history endpoint):
  `GET /api/meta-accounts/:id/insights` → `{ points: MetaInsightDay[] }`.

### 5. Dashboard

On the **existing** detail page `connections_.meta.$accountId.tsx`, below the
follower chart, add two insight panels reusing the recharts pattern already used by
`SubsHistoryChart`/`ViewsBarChart`:

- **Reach & Impressions** — a line chart with two series (reach, impressions) over `day`.
- **Profile views** — a bar chart over `day`.

A metric that is `null` for the account's platform (e.g. reach/profile-views on
Threads) renders a muted "Not available on {platform}" note in place of that
series/panel, rather than an empty chart. New `useMetaAccountInsights(id)` hook +
`MetaInsightDay` type in `api/meta-accounts.ts`.

### 6. Error handling

- Per-metric null on API rejection (deprecated metric) — no crash.
- Per-account isolation in the collector (one bad account doesn't abort the run).
- Token-redacted error messages (reuse `redactToken`).
- The manual `POST /stats/meta/refresh` (Phase A) now also collects insights, so it
  can be used to populate/verify on demand.

### 7. Testing

`node:test` via `npx tsx --test` (automation); dashboard via `tsc` + `vite build`.
- `fetchInsights` extraction + mapping per platform (mock axios with sample insights
  JSON; include a deprecated-metric error path → that metric null, others present).
- Collector: insights upsert called per active account; an insights error is isolated
  (followers still snapshot); `insightDays` counted.
- `MetaAccountInsightsRepository`: `upsertDay` conflict-update; `history` ordering/shape.
- Dashboard: `tsc` + `vite build`; Cyrillic-free guard on touched files.

## Out of scope (Phase C+)

Per-post insights (likes/reach per published post), audience demographics, follower
online-times, the Analytics-page (`/analytics`) Meta integration.

## Cost / safety guard (standing)

Build + `tsc` + unit tests only. No automation restart, no live API calls from the
build, no publishing. The user performs restarts and live smoke tests (the manual
refresh endpoint exists for that).
