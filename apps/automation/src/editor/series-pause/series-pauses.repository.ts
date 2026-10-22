import type { Pool } from 'pg';
import { SERIES_PAUSED_CODE } from './skip-cause';
import { pauseMapKey, type StreakSlot } from './streak';

/** A paused series (spec 060, migration 093). One open pause per (channelKey, key). */
export interface SeriesPause {
  id:         string;
  channelKey: string;
  /** `series:<name>` | `rule:<schedule_rule_id>` | `resource:<resource_ref>`. */
  key:        string;
  label:      string;
  cause:      'no_material' | 'source_unreachable' | 'owner';
  reason:     string;
  streak:     number;
  pausedAt:   Date;
  resumedAt:  Date | null;
  resumedBy:  string | null;
}

const toPause = (r: any): SeriesPause => ({
  id: r.id, channelKey: r.channel_key, key: r.series_key, label: r.label, cause: r.cause, reason: r.reason ?? '', streak: Number(r.streak ?? 0),
  pausedAt: r.paused_at, resumedAt: r.resumed_at ?? null, resumedBy: r.resumed_by ?? null,
});

/** The name inside a `series:<name>` key (null for the other kinds). */
export const seriesNameOfKey = (key: string): string | null => (key.startsWith('series:') ? key.slice('series:'.length) : null);
export const resourceOfKey = (key: string): string | null => (key.startsWith('resource:') ? key.slice('resource:'.length) : null);

/** The slots a pause stops: the same grouping as the streak counter (`streak.seriesIdOf`). */
function slotMatch(key: string, from: number): { sql: string; params: unknown[] } {
  if (key.startsWith('series:')) return { sql: `s.series_name = $${from}`, params: [key.slice(7)] };
  if (key.startsWith('rule:')) return { sql: `s.series_name IS NULL AND s.schedule_rule_id::text = $${from}`, params: [key.slice(5)] };
  return {
    sql: `s.series_name IS NULL AND s.schedule_rule_id IS NULL AND COALESCE(s.resource_ref, 'telegram:' || s.channel_key) = $${from}`,
    params: [key.slice('resource:'.length)],
  };
}

export const WINDOW_DAYS = 14;

export class SeriesPausesRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  /** A new open pause; null when the series already has one. */
  async insertOpen(p: { channelKey: string; key: string; label: string; cause: SeriesPause['cause']; reason: string; streak: number }): Promise<SeriesPause | null> {
    const { rows } = await this.pool.query(
      `INSERT INTO series_pauses (channel_key, series_key, label, cause, reason, streak) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (channel_key, series_key) WHERE resumed_at IS NULL DO NOTHING RETURNING *`,
      [p.channelKey, p.key, p.label.slice(0, 200), p.cause, p.reason.slice(0, 500), p.streak]);
    return rows[0] ? toPause(rows[0]) : null;
  }

  async get(id: string): Promise<SeriesPause | null> {
    const { rows } = await this.pool.query(`SELECT * FROM series_pauses WHERE id::text = $1`, [id]);
    return rows[0] ? toPause(rows[0]) : null;
  }

  /** Open pauses, optionally of one channel (case-insensitive key). */
  async open(channelKey?: string): Promise<SeriesPause[]> {
    const { rows } = channelKey
      ? await this.pool.query(`SELECT * FROM series_pauses WHERE resumed_at IS NULL AND lower(channel_key) = lower($1) ORDER BY paused_at`, [channelKey])
      : await this.pool.query(`SELECT * FROM series_pauses WHERE resumed_at IS NULL ORDER BY paused_at`);
    return rows.map(toPause);
  }

  /** Channels whose own plain slots (no series, no pin) are paused: the scheduler does not plan them. */
  async plainPausedChannels(): Promise<Set<string>> {
    const { rows } = await this.pool.query(
      `SELECT series_key FROM series_pauses WHERE resumed_at IS NULL AND series_key LIKE 'resource:telegram:%'`);
    return new Set(rows.map((r: any) => String(r.series_key).slice('resource:telegram:'.length)));
  }

  /** Open pauses first, then the most recent resumed ones — the channel's history. */
  async list(channelKey: string, limit = 20): Promise<SeriesPause[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM series_pauses WHERE lower(channel_key) = lower($1) ORDER BY (resumed_at IS NULL) DESC, paused_at DESC LIMIT $2`, [channelKey, limit]);
    return rows.map(toPause);
  }

  /** Resumes an open pause; null when it was not open. */
  async resume(id: string, by: string): Promise<SeriesPause | null> {
    const { rows } = await this.pool.query(
      `UPDATE series_pauses SET resumed_at = now(), resumed_by = $2 WHERE id::text = $1 AND resumed_at IS NULL RETURNING *`, [id, by.slice(0, 40)]);
    return rows[0] ? toPause(rows[0]) : null;
  }

  /** The latest resume per `<channelKey>|<key>`: slots closed before it do not count towards a new streak. */
  async lastResumes(): Promise<Map<string, Date>> {
    const { rows } = await this.pool.query(
      `SELECT channel_key, series_key, max(resumed_at) AS at FROM series_pauses WHERE resumed_at IS NOT NULL GROUP BY 1, 2`);
    return new Map(rows.map((r: any) => [pauseMapKey(r.channel_key, r.series_key), new Date(r.at)]));
  }

  /** Planned content slots of a paused series become skipped with `series_paused` ($0). Returns how many. */
  async skipPlanned(p: Pick<SeriesPause, 'channelKey' | 'key' | 'label'>): Promise<number> {
    const m = slotMatch(p.key, 3);
    const { rowCount } = await this.pool.query(
      `UPDATE editor_slots s SET status = 'skipped', error = $2, updated_at = now()
        WHERE s.kind = 'content' AND s.status = 'planned' AND s.channel_key = $1 AND ${m.sql}`,
      [p.channelKey, `${SERIES_PAUSED_CODE}: "${p.label}" is paused after repeated skips (spec 060)`.slice(0, 300), ...m.params]);
    return rowCount ?? 0;
  }

  /** Closed content slots of the last two weeks, for the streak counter. */
  async closedSlots(now: Date, channelKey?: string): Promise<StreakSlot[]> {
    const { rows } = await this.pool.query(
      `SELECT s.id::text AS id, s.channel_key, s.resource_ref, s.series_name, s.schedule_rule_id::text AS schedule_rule_id, s.topic,
              s.scheduled_at, s.updated_at, s.status, s.error, s.critic->>'verdict' AS verdict
         FROM editor_slots s
        WHERE s.kind = 'content' AND s.scheduled_at >= $1 AND s.scheduled_at <= $2
          AND ($3::text IS NULL OR s.channel_key = $3)
          AND s.status IN ('published', 'shadowed', 'awaiting_approval', 'approved', 'skipped', 'failed', 'expired')
        ORDER BY s.scheduled_at LIMIT 8000`,
      [new Date(now.getTime() - WINDOW_DAYS * 86_400_000), now, channelKey ?? null]);
    return rows.map((r: any) => ({
      id: r.id, channelKey: r.channel_key, resourceRef: r.resource_ref ?? null, seriesName: r.series_name ?? null,
      scheduleRuleId: r.schedule_rule_id ?? null, topic: r.topic ?? '', scheduledAt: new Date(r.scheduled_at), updatedAt: new Date(r.updated_at),
      status: r.status, error: r.error ?? null, criticVerdict: r.verdict ?? null,
    }));
  }

  /** The orchestrator agent of a channel (the Inbox note's owner), or null. */
  async agentOf(channelKey: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT id::text AS id FROM agents WHERE kind = 'orchestrator' AND parent_id IS NULL AND scope_id = $1 LIMIT 1`, [`telegram:${channelKey}`]);
    return rows[0]?.id ?? null;
  }
}

/** One line of a series' recent skips for the planner (spec 060 FR-002). */
export interface RecentSkip { key: string; label: string; line: string; at: Date }

/** `code: one line` of a slot error (the stable code before ':' when it looks like one, else "skipped"), at most 160 characters. */
export function skipLine(error: string | null | undefined): string {
  const e = (error ?? '').replace(/\s+/g, ' ').trim();
  const agent = /^skipped by agent:?\s*(.*)$/i.exec(e);
  const m = agent ? null : /^([a-z][a-z0-9_]{2,40})\b:?\s*(.*)$/.exec(e);
  const code = m ? m[1] : 'skipped';
  const body = agent ? agent[1] : m ? m[2] : e;
  const line = body ? `${code}: ${body}` : code;
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}
