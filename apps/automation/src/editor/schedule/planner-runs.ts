import type { Pool } from 'pg';

/**
 * Spec 073 FR-005 (A11): what the planner already tried on a channel-day, read from `editor_runs`, so a restart does not
 * forget it (the scheduler's `plannerTries` Map used to start from zero again).
 *
 *   - `n`           every `role = 'planner'` run of the channel that started on the local day `day` (in `tz`), and at or after
 *                   `opts.since` when given — the scheduler's runs, the owner's replans and Start's runs alike (074's ceiling reads this);
 *   - `failed`      those runs that left no plan behind (no `editor_plans.run_id` points at them);
 *   - `lastFailedAt` the latest `started_at` among the failed ones, or null.
 * One query; every field is parsed defensively (a missing row, a missing date).
 */
export interface PlannerRuns { n: number; failed: number; lastFailedAt: Date | null }

export async function plannerRunsOn(
  pool: Pick<Pool, 'query'>, channelKey: string, tz: string, day: string, opts: { since?: Date } = {},
): Promise<PlannerRuns> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE NOT r.made_plan)::int AS failed,
            max(r.started_at) FILTER (WHERE NOT r.made_plan) AS last_failed_at
       FROM (SELECT e.started_at, EXISTS (SELECT 1 FROM editor_plans p WHERE p.run_id = e.id) AS made_plan
               FROM editor_runs e
              WHERE e.role = 'planner' AND e.channel_key = $1
                AND (e.started_at AT TIME ZONE $2)::date = $3::date
                AND ($4::timestamptz IS NULL OR e.started_at >= $4::timestamptz)) r`,
    [channelKey, tz, day, opts.since ?? null]);
  const row = rows?.[0];
  const at = row?.last_failed_at ? new Date(row.last_failed_at) : null;
  return {
    n: Number(row?.n ?? 0) || 0,
    failed: Number(row?.failed ?? 0) || 0,
    lastFailedAt: at && !Number.isNaN(at.getTime()) ? at : null,
  };
}

const MAX_LINES = 5;
const MAX_LINE_CHARS = 200;

/**
 * Spec 073 FR-005: the validator's lines from the last failed call of a planner's terminal tool (`submit_plan` /
 * `submit_network_plan`) in one run — what the alert says when the planner gave up. Up to 5 lines of 200 characters; an
 * empty list when the run never called the tool or its last failing result has no lines.
 */
export async function lastToolErrors(pool: Pick<Pool, 'query'>, runId: string, tool: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT output FROM editor_run_steps
      WHERE run_id = $1 AND type = 'tool' AND tool_name = $2 AND is_error
      ORDER BY idx DESC LIMIT 1`,
    [runId, tool]);
  const details = rows?.[0]?.output?.details;
  const raw: unknown[] = Array.isArray(details) ? details : typeof details === 'string' ? [details] : [];
  return raw
    .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, MAX_LINES)
    .map((x) => (x.length > MAX_LINE_CHARS ? `${x.slice(0, MAX_LINE_CHARS - 1)}…` : x));
}

/** The alert's reasons clause: «Причини: a; b», or '' when there are none. */
export function reasonsClause(lines: readonly string[]): string {
  return lines.length ? `\nПричини: ${lines.join('; ')}` : '';
}
