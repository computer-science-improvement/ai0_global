import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';

/**
 * Spec 027 FR-010: the menu counters, `GET /api/nav/badges` → {generatedAt, counts}.
 *
 * Cheap by construction: ONE statement of scalar subqueries over indexed
 * columns, cached 10 s in memory (the dashboard polls every 30 s per tab, and
 * concurrent requests share one in-flight query). A source table that does not
 * exist (an older DB) answers null for its keys instead of failing the lot; if
 * the combined statement still fails, each key is retried on its own once and
 * a failing key is null — never a 500. "Today" = since Europe/Kyiv midnight
 * (BR-GEN-01; open question 5: no acknowledge step).
 */
export const BADGE_KEYS = [
  'agentInboxUnread', 'agentInboxCritical', 'directivesAwaitingOwner', 'chatPendingActions',
  'dmThreadsNew', 'dmActionsPending', 'slotsFailedToday', 'scheduledFailedToday',
] as const;
export type BadgeKey = typeof BADGE_KEYS[number];
export type BadgeCounts = Record<BadgeKey, number | null>;

/** `t.since` = the latest Kyiv midnight at or before $1 (now). */
const SINCE_CTE = `WITH t AS (SELECT (date_trunc('day', $1::timestamptz AT TIME ZONE 'Europe/Kyiv') AT TIME ZONE 'Europe/Kyiv') AS since)`;

export const BADGE_SOURCES: ReadonlyArray<{ key: BadgeKey; table: string; expr: string }> = [
  { key: 'agentInboxUnread',        table: 'agent_inbox',            expr: `(SELECT count(*)::int FROM agent_inbox WHERE read_at IS NULL)` },
  { key: 'agentInboxCritical',      table: 'agent_inbox',            expr: `(SELECT count(*)::int FROM agent_inbox WHERE read_at IS NULL AND severity = 'critical')` },
  { key: 'directivesAwaitingOwner', table: 'agent_directives',       expr: `(SELECT count(*)::int FROM agent_directives WHERE status IN ('awaiting_owner', 'contested'))` },
  { key: 'chatPendingActions',      table: 'pending_actions',        expr: `(SELECT count(*)::int FROM pending_actions WHERE status = 'pending')` },
  { key: 'dmThreadsNew',            table: 'agent_dm_threads',       expr: `(SELECT count(*)::int FROM agent_dm_threads WHERE status = 'new')` },
  { key: 'dmActionsPending',        table: 'agent_actions',          expr: `(SELECT count(*)::int FROM agent_actions WHERE status = 'pending')` },
  { key: 'slotsFailedToday',        table: 'editor_slots',           expr: `(SELECT count(*)::int FROM editor_slots WHERE status = 'failed' AND scheduled_at >= t.since)` },
  // A publication fails (or ends 'unknown') when it is attempted: count by the time it changed.
  { key: 'scheduledFailedToday',    table: 'scheduled_publications', expr: `(SELECT count(*)::int FROM scheduled_publications WHERE status IN ('failed', 'unknown') AND updated_at >= t.since)` },
];

const TABLES = [...new Set(BADGE_SOURCES.map((s) => s.table))];
const TTL_MS = 10_000;
/** `fresh` (right after the dashboard changed a count) still reuses a result younger than this. */
const FRESH_MIN_AGE_MS = 1_000;
const PROBE_TTL_MS = 5 * 60_000;

export interface NavBadges { generatedAt: string; counts: BadgeCounts }

export class NavBadgesService {
  private readonly logger = new Logger('NavBadges');
  private cached: { at: number; value: NavBadges } | null = null;
  private inflight: Promise<NavBadges> | null = null;
  private tables: { at: number; present: Set<string> } | null = null;

  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** `fresh`: the dashboard just changed a count (marked read, approved…), skip the 10 s cache. */
  async get(opts: { fresh?: boolean } = {}): Promise<NavBadges> {
    const t = this.now().getTime();
    const maxAge = opts.fresh ? FRESH_MIN_AGE_MS : TTL_MS;
    if (this.cached && t - this.cached.at < maxAge) return this.cached.value;
    if (!this.inflight) {
      this.inflight = this.compute()
        .then((value) => { this.cached = { at: this.now().getTime(), value }; return value; })
        .finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  /** Which source tables exist (to_regclass honours search_path). Cached for 5 minutes. */
  private async present(): Promise<Set<string>> {
    const t = this.now().getTime();
    if (this.tables && t - this.tables.at < PROBE_TTL_MS) return this.tables.present;
    const cols = TABLES.map((name, i) => `to_regclass($${i + 1}) IS NOT NULL AS "${name}"`).join(', ');
    const { rows } = await this.pool.query<Record<string, boolean>>(`SELECT ${cols}`, TABLES);
    const present = new Set(TABLES.filter((n) => rows[0]?.[n]));
    this.tables = { at: t, present };
    return present;
  }

  private async compute(): Promise<NavBadges> {
    const now = this.now();
    const counts = Object.fromEntries(BADGE_KEYS.map((k) => [k, null])) as BadgeCounts;
    let present: Set<string>;
    try { present = await this.present(); } catch (err: any) {
      this.logger.warn(`badge table probe failed: ${err?.message ?? err}`);
      return { generatedAt: now.toISOString(), counts };
    }
    const live = BADGE_SOURCES.filter((s) => present.has(s.table));
    if (live.length) {
      const select = BADGE_SOURCES.map((s) => `${present.has(s.table) ? s.expr : 'NULL::int'} AS "${s.key}"`).join(',\n  ');
      try {
        const { rows } = await this.pool.query<Record<string, number | null>>(`${SINCE_CTE}\nSELECT\n  ${select}\nFROM t`, [now.toISOString()]);
        for (const k of BADGE_KEYS) counts[k] = toCount(rows[0]?.[k]);
      } catch (err: any) {
        // One subquery is broken (e.g. a column missing on an old DB): isolate it.
        this.logger.warn(`badge query failed, retrying per key: ${err?.message ?? err}`);
        await Promise.all(live.map(async (s) => {
          try {
            const { rows } = await this.pool.query<{ n: number | null }>(`${SINCE_CTE}\nSELECT ${s.expr} AS n FROM t`, [now.toISOString()]);
            counts[s.key] = toCount(rows[0]?.n);
          } catch { counts[s.key] = null; }
        }));
      }
    }
    return { generatedAt: now.toISOString(), counts };
  }
}

function toCount(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
