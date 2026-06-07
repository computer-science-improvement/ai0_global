# Activity Logs Page — Design

**Goal:** A read-only "Logs" page in the dashboard showing recent automation activity (posts, errors, skips) with channel + strategy + time references, filterable by platform.

**Approach:** Surface existing DB data only — no new tables, no writes, no changes to the publishing pipeline. Zero risk to the running automation.

## Event model

A normalized `ActivityEvent` unioned from two well-referenced tables:

| Source | Rows → events | Channel ref | Strategy ref | Timestamp |
|---|---|---|---|---|
| `strategy_runs` | `ok` → posted, `error` → error, `skipped` → skipped (reason in `error`), `running` → running | join `strategy_bindings.channel_id → tracked_channels` | `ext_id` (+ binding type) | `started_at` |
| `scheduled_publications` | `sent` → posted, `failed` → error, `canceled` → skipped, `pending`/`sending` → running | `channel_id → tracked_channels` | — (manual one-off) | `updated_at` |

Normalized shape:

```ts
interface ActivityEvent {
  id:         string;            // `${source}:${rowId}`
  at:         string;            // ISO timestamp
  source:     'strategy_run' | 'scheduled_post';
  type:       'posted' | 'error' | 'skipped' | 'running';
  status:     string;            // raw source status
  channelId:  string | null;
  channel:    string | null;     // label: channel_key || username || title
  strategyId: string | null;
  strategy:   string | null;     // ext_id (manual → 'Запланований пост')
  detail:     string | null;     // error / skip reason
  durationMs: number | null;
}
```

**Covered:** posting, errors, skips (paused / previous-run-in-flight / canceled) — each with channel + strategy + time.

**Out of scope for v1 (flagged, not silently dropped):** per-fetch events (RSS/HTTP), semantic-dedup skips, cooldown skips — these are console-only (Winston) today and would need new pipeline instrumentation. AI calls (`ai_logs`) excluded because they carry no channel/strategy linkage, so rows would have blank references. All are clean follow-ups.

## Backend

`GET /activity?platform=telegram&type=&limit=50&offset=0`, guarded by `TrackingAuthGuard` (same as all dashboard endpoints).

- `ActivityRepository.list({ type, limit, offset })`: SQL `UNION ALL` of the two sources, each projecting the normalized columns (with channel/strategy joins via `LEFT JOIN`), `ORDER BY at DESC LIMIT $n OFFSET $m`. Fetch `limit + 1` rows to compute `hasMore` without a `COUNT`.
- `ActivityService` maps raw rows → `ActivityEvent[]` and returns `{ items, hasMore }`.
- `ActivityController` exposes the route; `platform !== 'telegram'` returns `{ items: [], hasMore: false }` (all current data is Telegram).
- `type` filter applied in the outer query (`WHERE type = $k`) when provided.
- New `ActivityModule` registered in `AppModule`.

## Frontend — `/logs`

- New route `apps/dashboard/src/routes/logs.tsx`.
- **Platform filter** (top): `Telegram` active; `Meta` + `TikTok` disabled chips — same grouping as the header/connections.
- **Type filter**: All / Публікації / Помилки / Пропущені / Виконується.
- **Table** columns: Час · Тип (colored badge) · Канал · Стратегія · Деталі (error/skip reason, else duration). Newest first; "Завантажити ще" pagination (offset += limit).
- **Nav**: under «Аналітика», next to «Статистика».
- API client `activityApi.list(params)` + `ActivityEvent` type in `api/types.ts`.

## Out of scope

No new tables, no writes, no pipeline changes. Pure read over `strategy_runs` + `scheduled_publications`.
