import type { Pool } from 'pg';
import { RESERVED_ONLY_RATIONALE, rowToSlot, type ApprovalRender, type EditorSlot } from '../../editor/repo/editor-plans.repository';

/**
 * Storage of the connector's posts (spec 103 §7, §8). Every write is one conditional statement, so the automation (the
 * approval publisher's claim, the executor's claim) and the connector can never both win a slot. Slots made here carry
 * `created_via = 'connector'` and `locked_by = 'connector'`; editing an agent's slot locks it.
 */

export const LOCK_CONNECTOR = 'connector';

/** What the connector keeps of a prepared (written) post. */
export interface PreparedFields {
  postSpec:        unknown;
  renderedPreview: string;
  renderMessages:  ApprovalRender;
  preparedMedia:   unknown;
  lintWarnings:    string[];
}

export interface NewPrepared extends PreparedFields {
  channelKey: string;
  /** The channel's local day of `at` (the plan the slot sits in). */
  planDate:   string;
  at:         Date;
  format:     string;
  topic:      string;
  status:     'awaiting_approval' | 'approved';
}

export interface NewPlanned {
  channelKey:  string;
  planDate:    string;
  at:          Date;
  format:      string;
  topic:       string;
  angle:       string | null;
  sourceHints: string[];
}

export interface PlannedPatch {
  topic?:       string;
  angle?:       string | null;
  format?:      string;
  at?:          Date;
  sourceHints?: string[];
  /** The channel's local day of `at`: when given with `at`, the slot moves into that day's active plan. */
  planDate?:    string;
}

/** The part of the store the connector's post service uses (a fake in unit tests). */
export interface ConnectorPostsStore {
  getSlot(id: string): Promise<EditorSlot | null>;
  insertPrepared(p: NewPrepared): Promise<string>;
  insertPlanned(p: NewPlanned): Promise<string>;
  /** A planned slot: topic, angle, format, time. Guarded: still planned and more than `lockBefore` away. Locks it. */
  patchPlanned(id: string, p: PlannedPatch, lockBefore: Date): Promise<EditorSlot | null>;
  /** A waiting or approved post: new text and/or time. Status is kept. Guarded by `lockBefore`. Locks it. */
  patchWritten(id: string, p: { fields?: PreparedFields; at?: Date; planDate?: string }, lockBefore: Date): Promise<EditorSlot | null>;
  /** planned, awaiting_approval or approved → skipped (`error` is the connector skip text). */
  cancel(id: string, error: string): Promise<EditorSlot | null>;
  /** Times of the channel's other live slots in [from, to] (the minimum-gap check). */
  busyTimes(channelKey: string, from: Date, to: Date, excludeId: string | null): Promise<Date[]>;
  /** Live slots (planned, running, waiting, approved, published) of the channel in [from, to): the daily-cap check. */
  countInRange(channelKey: string, from: Date, to: Date, excludeId: string | null): Promise<number>;
}

const LIVE_STATUSES = ['planned', 'running', 'awaiting_approval', 'approved', 'published'];

export class ConnectorPostsRepository implements ConnectorPostsStore {
  constructor(private readonly pool: Pool) {}

  async getSlot(id: string): Promise<EditorSlot | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    const { rows } = await this.pool.query(`SELECT * FROM editor_slots WHERE id = $1`, [id]);
    return rows[0] ? rowToSlot(rows[0]) : null;
  }

  /** The day's active plan (a placeholder one when the day has none yet; the scheduler still plans such a day). */
  private async planFor(client: { query: Pool['query'] }, channelKey: string, planDate: string): Promise<string> {
    await client.query(
      `INSERT INTO editor_plans (channel_key, plan_date, rationale) VALUES ($1, $2, $3)
       ON CONFLICT (channel_key, plan_date) WHERE status = 'active' DO NOTHING`,
      [channelKey, planDate, RESERVED_ONLY_RATIONALE]);
    const plan = await client.query(
      `SELECT id FROM editor_plans WHERE channel_key = $1 AND plan_date = $2 AND status = 'active' FOR UPDATE`, [channelKey, planDate]);
    return plan.rows[0].id;
  }

  private async inTx<T>(fn: (c: { query: Pool['query'] }) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client as unknown as { query: Pool['query'] });
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async insertPrepared(p: NewPrepared): Promise<string> {
    return this.inTx(async (c) => {
      const planId = await this.planFor(c, p.channelKey, p.planDate);
      const { rows } = await c.query(
        `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, kind, format, topic, source_hints, status, post_spec, rendered_preview,
                                   render_messages, prepared_media, lint_warnings, owner_edited, approved_at, approved_by,
                                   created_via, locked_by, locked_at, topic_mode)
         VALUES ($1, $2, $3, 'content', $4, $5, $6, $7, $8, $9, $10, $11, $12, true,
                 CASE WHEN $7 = 'approved' THEN now() END, CASE WHEN $7 = 'approved' THEN 'owner' END,
                 'connector', 'connector', now(), 'fixed')
         RETURNING id`,
        [planId, p.channelKey, p.at, p.format, p.topic.slice(0, 300), JSON.stringify(['connector:post']), p.status, JSON.stringify(p.postSpec),
          p.renderedPreview, JSON.stringify(p.renderMessages), JSON.stringify(p.preparedMedia ?? {}), JSON.stringify(p.lintWarnings)]);
      return rows[0].id as string;
    });
  }

  async insertPlanned(p: NewPlanned): Promise<string> {
    return this.inTx(async (c) => {
      const planId = await this.planFor(c, p.channelKey, p.planDate);
      const { rows } = await c.query(
        `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, kind, format, topic, angle, source_hints, status,
                                   created_via, locked_by, locked_at, topic_mode)
         VALUES ($1, $2, $3, 'content', $4, $5, $6, $7, 'planned', 'connector', 'connector', now(), 'fixed')
         RETURNING id`,
        [planId, p.channelKey, p.at, p.format, p.topic.slice(0, 300), p.angle, JSON.stringify(p.sourceHints)]);
      return rows[0].id as string;
    });
  }

  async patchPlanned(id: string, p: PlannedPatch, lockBefore: Date): Promise<EditorSlot | null> {
    const cur = await this.pool.query(`SELECT channel_key FROM editor_slots WHERE id = $1`, [id]);
    if (!cur.rows[0]) return null;
    return this.inTx(async (c) => {
      const sets: string[] = [];
      const params: unknown[] = [id, lockBefore];
      const add = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
      if (p.topic !== undefined) add('topic', p.topic.slice(0, 300));
      if (p.angle !== undefined) add('angle', p.angle);
      if (p.format !== undefined) add('format', p.format);
      if (p.at !== undefined) {
        add('scheduled_at', p.at);
        if (p.planDate) add('plan_id', await this.planFor(c, cur.rows[0].channel_key as string, p.planDate));
      }
      if (p.topic !== undefined || p.angle !== undefined) {
        // The owner's brief is the slot's whole direction: a live feed spec, an idea or a series row would override it.
        sets.push(`topic_mode = 'fixed'`, 'live_spec = NULL', 'idea_id = NULL', 'series_name = NULL');
        add('source_hints', JSON.stringify(['connector:plan']));
      } else if (p.sourceHints !== undefined) add('source_hints', JSON.stringify(p.sourceHints));
      const { rows } = await c.query(
        `UPDATE editor_slots SET ${[...sets, `locked_by = COALESCE(locked_by, 'connector')`, `locked_at = COALESCE(locked_at, now())`, 'updated_at = now()'].join(', ')}
          WHERE id = $1 AND status = 'planned' AND kind = 'content' AND scheduled_at > $2 RETURNING *`, params);
      return rows[0] ? rowToSlot(rows[0]) : null;
    });
  }

  async patchWritten(id: string, p: { fields?: PreparedFields; at?: Date; planDate?: string }, lockBefore: Date): Promise<EditorSlot | null> {
    const cur = await this.pool.query(`SELECT channel_key FROM editor_slots WHERE id = $1`, [id]);
    if (!cur.rows[0]) return null;
    return this.inTx(async (c) => {
      const sets: string[] = [];
      const params: unknown[] = [id, lockBefore];
      const add = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
      if (p.fields) {
        add('post_spec', JSON.stringify(p.fields.postSpec));
        add('rendered_preview', p.fields.renderedPreview);
        add('render_messages', JSON.stringify(p.fields.renderMessages));
        add('prepared_media', JSON.stringify(p.fields.preparedMedia ?? {}));
        add('lint_warnings', JSON.stringify(p.fields.lintWarnings));
        sets.push('owner_edited = true', 'error = NULL');
      }
      if (p.at) {
        add('scheduled_at', p.at);
        sets.push(`freshness_deadline = CASE WHEN freshness_deadline IS NULL THEN NULL ELSE $${params.length}::timestamptz + interval '30 minutes' END`);
        if (p.planDate) add('plan_id', await this.planFor(c, cur.rows[0].channel_key as string, p.planDate));
      }
      const { rows } = await c.query(
        `UPDATE editor_slots SET ${[...sets, `locked_by = COALESCE(locked_by, 'connector')`, `locked_at = COALESCE(locked_at, now())`, 'updated_at = now()'].join(', ')}
          WHERE id = $1 AND status IN ('awaiting_approval', 'approved') AND kind = 'content' AND scheduled_at > $2 RETURNING *`, params);
      return rows[0] ? rowToSlot(rows[0]) : null;
    });
  }

  async cancel(id: string, error: string): Promise<EditorSlot | null> {
    const { rows } = await this.pool.query(
      `UPDATE editor_slots SET status = 'skipped', error = $2, updated_at = now()
        WHERE id = $1 AND kind = 'content' AND status IN ('planned', 'awaiting_approval', 'approved') RETURNING *`, [id, error]);
    return rows[0] ? rowToSlot(rows[0]) : null;
  }

  async busyTimes(channelKey: string, from: Date, to: Date, excludeId: string | null): Promise<Date[]> {
    const { rows } = await this.pool.query(
      `SELECT scheduled_at FROM editor_slots
        WHERE channel_key = $1 AND resource_ref IS NULL AND ($4::uuid IS NULL OR id <> $4) AND status = ANY($5::text[])
          AND scheduled_at >= $2 AND scheduled_at <= $3`, [channelKey, from, to, excludeId, LIVE_STATUSES]);
    return rows.map((r) => new Date(r.scheduled_at));
  }

  async countInRange(channelKey: string, from: Date, to: Date, excludeId: string | null): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM editor_slots
        WHERE channel_key = $1 AND resource_ref IS NULL AND kind = 'content' AND ($4::uuid IS NULL OR id <> $4) AND status = ANY($5::text[])
          AND scheduled_at >= $2 AND scheduled_at < $3`, [channelKey, from, to, excludeId, LIVE_STATUSES]);
    return Number(rows[0]?.n ?? 0);
  }
}
