# Meta Follower Stats (Phase A) — Design

**Status:** approved (brainstorming) — 2026-06-12
**Branch:** `feat/meta-follower-stats` (off `feat/crosspost-all-strategies`)

## Goal

Track **follower-count over time** for each Meta account and surface it in the
dashboard in a way **consistent with Telegram channel stats** — i.e. an account
detail page with a "Followers over time" line chart plus the current count and a
short-term delta, mirroring the Telegram channel detail page's "Subscribers over
time" section.

Phase A only — follower counts. Richer insights (reach/impressions, per-post
metrics) are explicitly deferred (they need extra Graph scopes + App Review).

## What this mirrors (Telegram side)

The Telegram "My channels → channel detail" page (`channels_.$id.tsx`) fetches
`GET /tracking/channels/:id/subs-history` → `{ points: [{ at: ISO, subs }] }` and
renders it with `SubsHistoryChart` (a recharts `LineChart`). Snapshots are written
hourly into `tracked_subs_history(channel_id, snapshot_at, subs_count)`. We
reproduce this shape for Meta accounts.

## Follower-count availability (accuracy caveat)

`MetaGraphClient.verify(platform, targetId, token)` already returns a `followers`
number for **Instagram** (`followers_count`) and **Facebook** (`fan_count`) using
the tokens we already store. **Threads** does NOT expose follower count without
the gated `threads_manage_insights` scope, so `verify` returns `followers: null`
for Threads. Therefore Phase A captures history for IG + FB; Threads accounts
simply accrue no snapshots and the UI shows an empty state. No extra permissions
are required for IG/FB.

## Data model — migration `021_meta_follower_history.sql`

Mirrors `tracked_subs_history`:

```sql
CREATE TABLE IF NOT EXISTS meta_follower_history (
  account_id   UUID        NOT NULL REFERENCES meta_accounts(id) ON DELETE CASCADE,
  snapshot_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  followers    INTEGER     NOT NULL,
  PRIMARY KEY (account_id, snapshot_at)
);
CREATE INDEX IF NOT EXISTS idx_meta_follower_history_account_time
  ON meta_follower_history (account_id, snapshot_at DESC);
```

## Backend

### Collector — `MetaStatsCollectorService` (new, `apps/automation/src/stats/`)
- `@Cron(EVERY_HOUR)` + a public `runOnce()` for a manual refresh endpoint, mirroring
  `StatsCollectorService`. A re-entrancy guard (`running` flag) prevents overlap.
- For each **active** `meta_accounts` row: resolve the token via
  `config.get(token_env)` (same pattern as `CrossPostService`/`DestinationResolver`);
  skip with a debug log if the env var is unset. Call
  `MetaGraphClient.verify(platform, target_id, token)`.
  - Persist the refreshed profile via the existing meta-accounts verify-update repo
    method (keeps `username`/`display_name`/`followers`/`picture_url`/`last_verified_at`
    fresh — a free side benefit, same as the manual Verify button).
  - If `followers` is a number, insert a snapshot into `meta_follower_history`.
    If `followers` is null (Threads, or a transient miss), insert nothing.
- Per-account failures are caught + logged and never abort the loop (one bad token
  doesn't stop the others). The whole job no-ops cleanly if there are no active accounts.
- Dedicated service — NOT folded into `StatsCollectorService`, which is gramjs/Telegram
  specific and no-ops when gramjs creds are absent.

### Repository — `MetaFollowerHistoryRepository` (new)
- `insert(accountId, followers)` → writes a snapshot (now()).
- `history(accountId, from?, to?)` → `{ at: Date, followers: number }[]` ordered
  `snapshot_at ASC`, optional ISO from/to range (mirrors `channelTimeseries`).
- `latestWithDelta(accountId)` → `{ followers: number | null, delta24h: number | null,
  delta7d: number | null }` computed from the snapshot nearest-at-or-before the cutoff
  (mirrors `stats.service.channelsSummary`'s 24h delta).

### API — extend `meta-accounts.controller` (`api/meta-accounts`)
- `GET /api/meta-accounts/:id/follower-history?from&to` →
  `{ accountId, current: number | null, delta24h: number | null, delta7d: number | null,
     points: [{ at: ISO, followers: number }] }`.
  One call powers the whole detail page (header numbers + chart).

The hourly cron is the only writer in Phase A — no manual-refresh endpoint (YAGNI; a
restart triggers a fresh boot-time pass, and the user can wait for the next tick).

## Dashboard

- **API hook** — in `src/api/meta-accounts.ts`: `useMetaFollowerHistory(id)` →
  `GET /api/meta-accounts/:id/follower-history`. New type
  `MetaFollowerHistory { current: number | null; delta24h: number | null;
   delta7d: number | null; points: { at: string; followers: number }[] }`.
- **Detail route** — new route at `/connections/meta/:accountId` (TanStack file route,
  e.g. `connections_.meta.$accountId.tsx`). It shows:
  - a header (avatar, display name / @username, platform glyph) and a small StatCard row:
    **Followers** (current), **Δ 24h**, **Δ 7d** — reusing the existing `StatCard`.
  - a "Followers over time" `Section` rendering `SubsHistoryChart` via a thin adapter:
    `points.map(p => ({ at: p.at, subs: p.followers }))` (no chart change needed —
    the chart is label-agnostic; the Section title says "Followers over time").
  - an empty state ("No follower data yet — IG/FB only; Threads needs insights access.")
    when `points` is empty.
- **Navigation into it** — make each account card in `MetaAccountsManager` clickable,
  linking to `/connections/meta/:accountId` (the Telegram pattern: list row → detail).
  The card itself is unchanged otherwise.

No new sidebar entry — the detail lives under the existing Connections·Meta hub, reached
by clicking an account (consistent with My channels → channel detail, which also has no
separate nav entry).

## Testing

`node:test` via `npx tsx --test` (automation); dashboard via `tsc` + `vite build`.

- **Collector** (`MetaStatsCollectorService`): with a fake graph client + fake repos —
  inserts a snapshot when `followers` is a number; inserts nothing when `followers` is
  null (Threads); a throwing account does not abort the loop (the next account still runs);
  skips accounts whose `token_env` is unset.
- **Repository** (`MetaFollowerHistoryRepository`): with a fake `pool` that captures
  `query(sql, params)` — assert `history` orders ASC and threads the from/to params;
  assert `latestWithDelta` computes the delta. **SQL-shape guard:** assert the generated
  SQL strings are well-formed (parameter placeholders present, any `jsonb`/cast usage
  explicit) — this is the runnable guard for the class of bug that hit `markPosted`
  today (a bare untyped parameter), since real-DB tests can't run in this environment.
- **Optional integration test** (gated on `TEST_DATABASE_URL`, skipped when unset): run
  the real `insert`/`history` SQL against a Postgres to catch type-inference bugs end to
  end. It will not run in this session (no test DB) but is the correct artifact for CI.
- **Controller**: the follower-history endpoint returns the `{ current, delta24h, delta7d,
  points }` shape from faked repo data.
- **Dashboard**: `tsc` + `vite build` + Cyrillic guard (UI is English-only).

## Cost / safety guard (standing)

Build, `tsc`, and unit tests only. **No** automation restart, **no** live Graph API calls,
**no** Claude API. The user restarts and verifies; the hourly cron + real follower fetches
run only in the user's environment. Migration `021` applies on the user's next boot.

## Out of scope (later phases)

- Account insights: reach, impressions, profile views (needs `instagram_manage_insights`
  / `read_insights` / `threads_manage_insights` + likely App Review).
- Per-post Meta metrics (needs persisting the published media id + polling insights).
- Threads follower history (gated scope).
- A combined cross-platform analytics page (the platform filter could later switch the
  Analytics page between Telegram and Meta — not Phase A).
