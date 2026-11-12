/**
 * Spec 103 WP-B PG fixtures (style A: a throwaway database per test file, prefix `p103b_`). A "connector-shaped" slot is what
 * prepare_post / plan_post write: kind 'content', no resource_ref, created_via 'connector', locked_by 'connector'.
 * Not a test file. Never point EDITOR_PG_TEST_URL at a real database.
 */
import type { Pool } from 'pg';
import { createMigratedDb, type FreshDb } from '../../sysadmin/testing/fresh-db';
import { renderTelegram } from '../../post/render-telegram';
import { makeCard, makeSpec } from '../../post/testing/fixtures';
import type { EditorCard } from '../../card';

/** Friday 2026-11-06 11:00 Kyiv. */
export const NOW = new Date('2026-11-06T09:00:00Z');
export const DAY = '2026-11-06';
export const HOUR = 3_600_000;
export const at = (hh: string, day = DAY) => new Date(`${day}T${hh}:00Z`);

export type LockMode = 'connector' | 'owner' | null;
/** The three shapes every lock test runs: both lock owners and the unlocked baseline. */
export const SHAPES: Array<{ name: string; lockedBy: LockMode }> = [
  { name: 'locked by the connector', lockedBy: 'connector' },
  { name: 'locked by the owner', lockedBy: 'owner' },
  { name: 'unlocked', lockedBy: null },
];

export interface SlotSeed {
  at: Date;
  status?: string;
  kind?: 'content' | 'reserved';
  lockedBy?: LockMode;
  /** Default: 'connector' when the slot is locked by the connector. */
  createdVia?: 'connector' | null;
  topic?: string;
  hints?: string[];
  seriesName?: string | null;
  resourceRef?: string | null;
  error?: string | null;
  retryAt?: Date | null;
  ownerEdited?: boolean;
  derivedFrom?: string | null;
  promo?: unknown;
  ideaId?: string | null;
  updatedAt?: Date;
  /** A stored post (awaiting_approval / approved need one). Default: true for those two statuses. */
  written?: boolean;
}

export class LockFx {
  private seq = 0;
  constructor(readonly db: FreshDb) {}
  get pool(): Pool { return this.db.pool; }

  static async create(url: string, name: string): Promise<LockFx> {
    return new LockFx(await createMigratedDb(url, `p103b_${name}`));
  }
  drop() { return this.db.drop(); }

  /** A fresh channel (tracked + editor card row). */
  async channel(o: { mode?: 'live' | 'approve' | 'shadow' | 'off'; extra?: Partial<EditorCard>; holdHours?: number } = {}): Promise<EditorCard> {
    const key = `@p103b_${++this.seq}`;
    const mode = o.mode ?? 'live';
    await this.pool.query(`INSERT INTO tracked_channels (channel_key, username, title, is_mine) VALUES ($1, $2, 'p103b', true)`, [key, key.slice(1)]);
    await this.pool.query(
      `INSERT INTO editor_channels (channel_key, mode, plan_hour, formats, hashtags, posts_per_day_min, posts_per_day_max)
       VALUES ($1, $2, 0, '{"text":1}', '{космос,nasa,фото}', 3, 5)`, [key, mode]);
    if (o.holdHours != null) await this.pool.query(`UPDATE editor_channels SET approval_hold_hours = $2 WHERE channel_key = $1`, [key, o.holdHours]);
    return makeCard({ channelKey: key, mode, postsPerDayMin: 3, postsPerDayMax: 5, planHour: 0, ...(o.extra ?? {}) });
  }

  async setMode(key: string, mode: string) { await this.pool.query(`UPDATE editor_channels SET mode = $2 WHERE channel_key = $1`, [key, mode]); }

  /** The active plan of (channel, day), created on demand. */
  async plan(key: string, day = DAY, rationale = 'p103b test plan'): Promise<string> {
    const cur = await this.pool.query(`SELECT id FROM editor_plans WHERE channel_key = $1 AND plan_date = $2 AND status = 'active'`, [key, day]);
    if (cur.rows[0]) return cur.rows[0].id;
    return (await this.pool.query(`INSERT INTO editor_plans (channel_key, plan_date, rationale) VALUES ($1, $2, $3) RETURNING id`, [key, day, rationale])).rows[0].id;
  }

  /** Insert one slot into the channel's active plan of `day`. */
  async slot(key: string, s: SlotSeed, day = DAY): Promise<string> {
    const planId = await this.plan(key, day);
    const status = s.status ?? 'planned';
    const lockedBy = s.lockedBy ?? null;
    const createdVia = s.createdVia !== undefined ? s.createdVia : lockedBy === 'connector' ? 'connector' : null;
    const written = s.written ?? (status === 'awaiting_approval' || status === 'approved');
    const spec = makeSpec({ format: 'text', media: [], title: s.topic ?? 'p103b post', source: { url: `https://src.example/${++this.seq}`, label: 'Src' } });
    const r = written ? renderTelegram(spec, makeCard({ channelKey: key })) : null;
    const { rows } = await this.pool.query(
      `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, kind, format, topic, source_hints, status, error, retry_at, series_name, resource_ref,
                                 owner_edited, derived_from_slot_id, promo, idea_id, post_spec, rendered_preview, render_messages,
                                 approved_at, approved_by, created_via, locked_by, locked_at, updated_at)
       VALUES ($1,$2,$3,$4,'text',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id`,
      [planId, key, s.at, s.kind ?? 'content', s.topic ?? 'p103b topic', JSON.stringify(s.hints ?? []), status, s.error ?? null, s.retryAt ?? null,
        s.seriesName ?? null, s.resourceRef ?? null, s.ownerEdited ?? false, s.derivedFrom ?? null, s.promo == null ? null : JSON.stringify(s.promo), s.ideaId ?? null,
        written ? JSON.stringify(spec) : null, r?.preview ?? null, r ? JSON.stringify({ kind: 'telegram', messages: r.messages, primary: r.primary }) : null,
        status === 'approved' ? NOW : null, status === 'approved' ? 'owner' : null,
        createdVia, lockedBy, lockedBy ? NOW : null, s.updatedAt ?? new Date()]);
    return rows[0].id;
  }

  async row(id: string): Promise<any> { return (await this.pool.query(`SELECT * FROM editor_slots WHERE id = $1`, [id])).rows[0]; }
  /** [status, error] of a slot: what the writers change. */
  async state(id: string): Promise<[string, string | null]> { const r = await this.row(id); return [r.status, r.error]; }
}
