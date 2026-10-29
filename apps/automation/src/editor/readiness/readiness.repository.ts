import type { Pool } from 'pg';
import type { Finding } from '../sysadmin/audit.types';

/**
 * Spec 072 FR-005 (migration 097): the stored result of the channel doctor, one row per channel card. The service resolves the
 * card's own spelling of the key first (A27), so every method here compares `channel_key` as it is stored.
 *
 * `upsert` never writes `applied_hash`: spec 074 owns that column and writes it through `setAppliedHash` after it has repaired
 * a plan. 072 only reads it back, so a hook can compare it with the hash of the config.
 */
export interface ReadinessRow {
  channelKey:       string;
  findings:         Finding[];
  blockers:         number;
  warnings:         number;
  configHash:       string;
  appliedHash:      string | null;
  checkedAt:        Date;
  notifiedAt:       Date | null;
  /** Sorted finding keys the last owner-bot card named. */
  notifiedBlockers: string[];
}

export interface ReadinessWrite {
  channelKey: string;
  findings:   Finding[];
  blockers:   number;
  warnings:   number;
  configHash: string;
  checkedAt:  Date;
  /** Left out = the stored value stays; `notifiedAt` only ever moves to a new time (a clear leaves it as it is, A9). */
  notifiedBlockers?: string[];
  notifiedAt?:       Date;
}

const toRow = (r: any): ReadinessRow => ({
  channelKey: r.channel_key,
  findings: Array.isArray(r.findings) ? r.findings : [],
  blockers: Number(r.blockers ?? 0), warnings: Number(r.warnings ?? 0),
  configHash: r.config_hash ?? '', appliedHash: r.applied_hash ?? null,
  checkedAt: new Date(r.checked_at),
  notifiedAt: r.notified_at ? new Date(r.notified_at) : null,
  notifiedBlockers: Array.isArray(r.notified_blockers) ? r.notified_blockers.map(String) : [],
});

/**
 * The channels the sweep keeps checked and may notify about: a card in approve or live mode, or a channel with an open launch
 * (ready or running). Shadow and off cards are looked at when somebody opens them, never by the sweep.
 */
export const IN_SWEEP = `(c.mode IN ('approve', 'live')
    OR EXISTS (SELECT 1 FROM channel_launches l WHERE lower(l.channel_key) = lower(c.channel_key) AND lower(l.status) IN ('ready', 'running')))`;

export class ReadinessRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async get(channelKey: string): Promise<ReadinessRow | null> {
    const { rows } = await this.pool.query(`SELECT * FROM channel_readiness WHERE channel_key = $1`, [channelKey]);
    return rows[0] ? toRow(rows[0]) : null;
  }

  /** Stores what the doctor found. `applied_hash` is not in the statement, so an update keeps it and an insert leaves it NULL. */
  async upsert(w: ReadinessWrite): Promise<ReadinessRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO channel_readiness (channel_key, findings, blockers, warnings, config_hash, checked_at, notified_at, notified_blockers)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6::timestamptz, $7::timestamptz, COALESCE($8::jsonb, '[]'::jsonb))
       ON CONFLICT (channel_key) DO UPDATE SET
         findings = EXCLUDED.findings, blockers = EXCLUDED.blockers, warnings = EXCLUDED.warnings,
         config_hash = EXCLUDED.config_hash, checked_at = EXCLUDED.checked_at,
         notified_at = COALESCE($7::timestamptz, channel_readiness.notified_at),
         notified_blockers = COALESCE($8::jsonb, channel_readiness.notified_blockers)
       RETURNING *`,
      [w.channelKey, JSON.stringify(w.findings), w.blockers, w.warnings, w.configHash, w.checkedAt,
        w.notifiedAt ?? null, w.notifiedBlockers ? JSON.stringify(w.notifiedBlockers) : null]);
    return toRow(rows[0]);
  }

  /** Spec 074 writes the hash of the config it last repaired the plan for. False = the channel has no row yet. */
  async setAppliedHash(channelKey: string, hash: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`UPDATE channel_readiness SET applied_hash = $2 WHERE channel_key = $1`, [channelKey, hash]);
    return (rowCount ?? 0) > 0;
  }

  /** The cards' own spellings of the keys the sweep covers, in key order. */
  async sweepSet(): Promise<string[]> {
    const { rows } = await this.pool.query(`SELECT c.channel_key FROM editor_channels c WHERE ${IN_SWEEP} ORDER BY c.channel_key`);
    return rows.map((r: any) => r.channel_key);
  }

  async inSweepSet(channelKey: string): Promise<boolean> {
    const { rows } = await this.pool.query(`SELECT 1 FROM editor_channels c WHERE c.channel_key = $1 AND ${IN_SWEEP}`, [channelKey]);
    return rows.length > 0;
  }
}
