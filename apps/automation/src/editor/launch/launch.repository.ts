import type { Pool } from 'pg';
import {
  OPEN_LAUNCH_STATUSES, type ChannelLaunch, type LaunchBotState, type LaunchGraduation, type LaunchPromo, type LaunchRef, type LaunchStatus,
} from './launch.types';

/** channel_launches (086, spec 052). */

const toLaunch = (r: any): ChannelLaunch => ({
  id: r.id, channelKey: r.channel_key, targetRef: r.target_ref, title: r.title ?? null, brief: r.brief,
  refs: Array.isArray(r.refs) ? r.refs : [], status: r.status, reason: r.reason ?? null, retryAt: r.retry_at ?? null,
  plan: r.plan ?? null, checklist: r.checklist ?? null, startRequested: !!r.start_requested, startedAt: r.started_at ?? null,
  graduation: r.graduation ?? {}, promo: r.promo ?? null, subsAtStart: r.subs_at_start == null ? null : Number(r.subs_at_start),
  botCheckedAt: r.bot_checked_at ?? null, botState: r.bot_state ?? null, agentId: r.agent_id ?? null, runId: r.run_id ?? null,
  costUsd: Number(r.cost_usd ?? 0), createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  graduatedAt: r.graduated_at ?? null,
});

export interface LaunchPatch {
  title:          string | null;
  brief:          string;
  refs:           LaunchRef[];
  status:         LaunchStatus;
  reason:         string | null;
  retryAt:        Date | null;
  plan:           unknown;
  checklist:      unknown;
  startRequested: boolean;
  startedAt:      Date | null;
  graduation:     LaunchGraduation;
  promo:          LaunchPromo | null;
  subsAtStart:    number | null;
  botCheckedAt:   Date | null;
  botState:       LaunchBotState | null;
  agentId:        string | null;
  runId:          string | null;
  costUsd:        number;
  graduatedAt:    Date | null;
}

const JSON_COLS = new Set(['refs', 'plan', 'checklist', 'graduation', 'promo', 'bot_state']);
const COLS: Record<keyof LaunchPatch, string> = {
  title: 'title', brief: 'brief', refs: 'refs', status: 'status', reason: 'reason', retryAt: 'retry_at', plan: 'plan',
  checklist: 'checklist', startRequested: 'start_requested', startedAt: 'started_at', graduation: 'graduation', promo: 'promo',
  subsAtStart: 'subs_at_start', botCheckedAt: 'bot_checked_at', botState: 'bot_state', agentId: 'agent_id', runId: 'run_id',
  costUsd: 'cost_usd', graduatedAt: 'graduated_at',
};

export class LaunchRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  /** A new launch; null when the channel already has an open one (the partial unique index). */
  async insert(l: { channelKey: string; title: string | null; brief: string; refs: LaunchRef[]; createdBy: string }): Promise<ChannelLaunch | null> {
    const { rows } = await this.pool.query(
      `INSERT INTO channel_launches (channel_key, target_ref, title, brief, refs, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (channel_key) WHERE status IN ('queued','preparing','analyzing','ready','running') DO NOTHING
       RETURNING *`,
      [l.channelKey, `telegram:${l.channelKey}`, l.title, l.brief, JSON.stringify(l.refs), l.createdBy]);
    return rows[0] ? toLaunch(rows[0]) : null;
  }

  async get(id: string): Promise<ChannelLaunch | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { rows } = await this.pool.query(`SELECT * FROM channel_launches WHERE id = $1`, [id]);
    return rows[0] ? toLaunch(rows[0]) : null;
  }

  /** The channel's open launch (queued … running). */
  async openFor(channelKey: string): Promise<ChannelLaunch | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM channel_launches WHERE lower(channel_key) = lower($1) AND status = ANY($2) ORDER BY created_at DESC LIMIT 1`,
      [channelKey, OPEN_LAUNCH_STATUSES]);
    return rows[0] ? toLaunch(rows[0]) : null;
  }

  async list(f: { channel?: string | null; status?: string | null; limit?: number } = {}): Promise<ChannelLaunch[]> {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (f.channel) { vals.push(f.channel); where.push(`lower(channel_key) = lower($${vals.length})`); }
    if (f.status) { vals.push(f.status); where.push(`status = $${vals.length}`); }
    vals.push(Math.min(Math.max(f.limit ?? 50, 1), 200));
    const { rows } = await this.pool.query(
      `SELECT * FROM channel_launches ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${vals.length}`, vals);
    return rows.map(toLaunch);
  }

  /** Launches the minute tick works on, oldest first. */
  async active(statuses: readonly LaunchStatus[], now: Date): Promise<ChannelLaunch[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM channel_launches WHERE status = ANY($1) AND (retry_at IS NULL OR retry_at <= $2) ORDER BY created_at LIMIT 50`,
      [statuses, now]);
    return rows.map(toLaunch);
  }

  /** Move a launch from one status to the next only when it is still in `from` (one worker wins). */
  async transition(id: string, from: readonly LaunchStatus[], p: Partial<LaunchPatch>): Promise<ChannelLaunch | null> {
    return this.write(id, p, from);
  }

  /** Launches left `analyzing` by a restart go back to `preparing` (the analysis runs again). */
  async requeueStuck(olderThan: Date): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE channel_launches SET status = 'preparing', updated_at = now() WHERE status = 'analyzing' AND updated_at < $1`, [olderThan]);
    return rowCount ?? 0;
  }

  async update(id: string, p: Partial<LaunchPatch>): Promise<ChannelLaunch | null> {
    return this.write(id, p, null);
  }

  private async write(id: string, p: Partial<LaunchPatch>, from: readonly LaunchStatus[] | null): Promise<ChannelLaunch | null> {
    const set: string[] = [];
    const vals: unknown[] = [id];
    for (const [k, col] of Object.entries(COLS) as Array<[keyof LaunchPatch, string]>) {
      const v = p[k];
      if (v === undefined) continue;
      vals.push(JSON_COLS.has(col) && v !== null ? JSON.stringify(v) : v);
      set.push(`${col} = $${vals.length}`);
    }
    let guard = '';
    if (from) { vals.push(from); guard = ` AND status = ANY($${vals.length})`; }
    const { rows } = await this.pool.query(
      `UPDATE channel_launches SET ${[...set, 'updated_at = now()'].join(', ')} WHERE id = $1${guard} RETURNING *`, vals);
    return rows[0] ? toLaunch(rows[0]) : null;
  }
}
