/**
 * Spec 091 FR-002: the `channel_slo` day rows (migration 104). `upsert` never throws (the controller must not stop the
 * scheduler tick on a missing table): it logs and returns false.
 */
import type { Pool } from 'pg';
import type { SloState } from './types';

export interface ChannelSloRow {
  channelKey:   string;
  /** The channel's local day, YYYY-MM-DD. */
  day:          string;
  target:       number;
  published:    number;
  plannedAhead: number;
  skipped:      number;
  replacements: number;
  recoveryRuns: number;
  state:        SloState;
  reason:       string | null;
  lastPostAt:   Date | null;
  darkSince:    Date | null;
  updatedAt:    Date;
}

const ymd = (v: unknown): string => (v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  : String(v).slice(0, 10));

const toRow = (r: any): ChannelSloRow => ({
  channelKey: r.channel_key, day: ymd(r.day), target: Number(r.target), published: Number(r.published),
  plannedAhead: Number(r.planned_ahead), skipped: Number(r.skipped), replacements: Number(r.replacements),
  recoveryRuns: Number(r.recovery_runs), state: r.state, reason: r.reason ?? null,
  lastPostAt: r.last_post_at ? new Date(r.last_post_at) : null, darkSince: r.dark_since ? new Date(r.dark_since) : null,
  updatedAt: new Date(r.updated_at),
});

export type SloUpsert = Omit<ChannelSloRow, 'updatedAt' | 'replacements' | 'recoveryRuns'> & Partial<Pick<ChannelSloRow, 'replacements' | 'recoveryRuns'>>;

export class ChannelSloRepository {
  constructor(private readonly pool: Pool, private readonly log: (m: string) => void = () => {}) {}

  /** Write the day row. `replacements` / `recoveryRuns` are kept unless given (they are bumped with `bump`). */
  async upsert(r: SloUpsert): Promise<boolean> {
    try {
      await this.pool.query(
        `INSERT INTO channel_slo (channel_key, day, target, published, planned_ahead, skipped, replacements, recovery_runs,
                                  state, reason, last_post_at, dark_since, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 0), COALESCE($8, 0), $9, $10, $11, $12, now())
         ON CONFLICT (channel_key, day) DO UPDATE SET
           target = EXCLUDED.target, published = EXCLUDED.published, planned_ahead = EXCLUDED.planned_ahead,
           skipped = EXCLUDED.skipped,
           replacements  = COALESCE($7, channel_slo.replacements),
           recovery_runs = COALESCE($8, channel_slo.recovery_runs),
           state = EXCLUDED.state, reason = EXCLUDED.reason, last_post_at = EXCLUDED.last_post_at,
           dark_since = EXCLUDED.dark_since, updated_at = now()`,
        [r.channelKey, r.day, r.target, r.published, r.plannedAhead, r.skipped, r.replacements ?? null, r.recoveryRuns ?? null,
          r.state, r.reason, r.lastPostAt, r.darkSince]);
      return true;
    } catch (err: any) {
      this.log(`channel_slo not written (${r.channelKey} ${r.day}): ${err?.message ?? err}`);
      return false;
    }
  }

  /** Add to the day's replacement or recovery counter (the row must exist; returns the new value or null). */
  async bump(channelKey: string, day: string, field: 'replacements' | 'recovery_runs', by = 1): Promise<number | null> {
    try {
      const { rows } = await this.pool.query(
        `UPDATE channel_slo SET ${field} = ${field} + $3, updated_at = now() WHERE channel_key = $1 AND day = $2 RETURNING ${field} AS n`,
        [channelKey, day, by]);
      return rows[0] ? Number(rows[0].n) : null;
    } catch (err: any) {
      this.log(`channel_slo ${field} not bumped (${channelKey} ${day}): ${err?.message ?? err}`);
      return null;
    }
  }

  async get(channelKey: string, day: string): Promise<ChannelSloRow | null> {
    const { rows } = await this.pool.query(`SELECT * FROM channel_slo WHERE channel_key = $1 AND day = $2`, [channelKey, day]);
    return rows[0] ? toRow(rows[0]) : null;
  }

  /** All channels' rows of one day. */
  async forDay(day: string): Promise<ChannelSloRow[]> {
    const { rows } = await this.pool.query(`SELECT * FROM channel_slo WHERE day = $1 ORDER BY channel_key`, [day]);
    return rows.map(toRow);
  }

  /** The last `days` rows per channel up to `day` inclusive (the 7-day strip), newest first. */
  async history(day: string, days = 7, channelKey?: string | null): Promise<ChannelSloRow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM channel_slo WHERE day <= $1::date AND day > $1::date - $2::int AND ($3::text IS NULL OR channel_key = $3)
        ORDER BY channel_key, day DESC`, [day, days, channelKey ?? null]);
    return rows.map(toRow);
  }

  /** The newest row of a channel before `day` (dark_since carries over midnight). */
  async lastBefore(channelKey: string, day: string): Promise<ChannelSloRow | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM channel_slo WHERE channel_key = $1 AND day < $2::date ORDER BY day DESC LIMIT 1`, [channelKey, day]);
    return rows[0] ? toRow(rows[0]) : null;
  }
}
