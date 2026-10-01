import type { Pool } from 'pg';
import type { PlannedSlot } from '../roles/plan-rules';

export type SlotStatus = 'planned' | 'running' | 'published' | 'shadowed' | 'skipped' | 'failed';

export interface EditorSlot {
  id:              string;
  planId:          string;
  channelKey:      string;
  scheduledAt:     Date;
  kind:            'content' | 'reserved';
  format:          string;
  topic:           string;
  angle:           string | null;
  sourceHints:     string[];
  isExperiment:    boolean;
  status:          SlotStatus;
  attempts:        number;
  runId:           string | null;
  publishedPostId: number | null;
  postSpec:        unknown;
  renderedPreview: string | null;
  error:           string | null;
}

/** Rationale of a plan created only to hold reserved (ad) slots; the planner still plans that day. */
export const RESERVED_ONLY_RATIONALE = 'reserved only';

export interface ReserveSlotInput {
  channelKey:  string;
  planDate:    string;
  scheduledAt: Date;
  format:      string;
  topic:       string;
  /** Traceability, e.g. ['ad_order:<uuid>']. */
  sourceHints: string[];
  /** Snapshot of the approved creative; published as-is. */
  postSpec:    unknown;
}

export function rowToSlot(r: any): EditorSlot {
  return {
    id: r.id, planId: r.plan_id, channelKey: r.channel_key, scheduledAt: new Date(r.scheduled_at),
    kind: r.kind, format: r.format, topic: r.topic, angle: r.angle ?? null, sourceHints: r.source_hints ?? [],
    isExperiment: !!r.is_experiment, status: r.status, attempts: Number(r.attempts), runId: r.run_id ?? null,
    publishedPostId: r.published_post_id == null ? null : Number(r.published_post_id),
    postSpec: r.post_spec ?? null, renderedPreview: r.rendered_preview ?? null, error: r.error ?? null,
  };
}

export interface EditorPlan {
  id:         string;
  channelKey: string;
  planDate:   string;
  status:     'active' | 'superseded';
  rationale:  string | null;
  runId:      string | null;
  createdAt:  Date;
  slots:      EditorSlot[];
}

export interface SlotStatusCount {
  channelKey: string;
  planDate:   string;
  status:     SlotStatus;
  n:          number;
}

export interface SlotResultPatch {
  status?:          SlotStatus;
  runId?:           string | null;
  publishedPostId?: number | null;
  postSpec?:        unknown;
  renderedPreview?: string | null;
  error?:           string | null;
  scheduledAt?:     Date;
}

export class EditorPlansRepository {
  constructor(private readonly pool: Pool) {}

  async getActivePlan(channelKey: string, planDate: string): Promise<{ id: string; rationale: string | null } | null> {
    const { rows } = await this.pool.query(
      `SELECT id, rationale FROM editor_plans WHERE channel_key = $1 AND plan_date = $2 AND status = 'active'`,
      [channelKey, planDate]);
    return rows[0] ?? null;
  }

  /** Reserved (ad) slots of the day — fixed points the planner must plan around. */
  async reservedSlots(channelKey: string, from: Date, to: Date): Promise<EditorSlot[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM editor_slots WHERE channel_key = $1 AND kind = 'reserved'
          AND status IN ('planned','running') AND scheduled_at >= $2 AND scheduled_at < $3 ORDER BY scheduled_at`,
      [channelKey, from, to]);
    return rows.map(rowToSlot);
  }

  /**
   * Put a reserved (paid ad) slot into the day's active plan. When the day has
   * no plan yet, a plan with RESERVED_ONLY_RATIONALE is created; the scheduler
   * still runs the planner for such a day and createPlan moves the reserved
   * slot into the real plan.
   */
  async reserveSlot(i: ReserveSlotInput): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO editor_plans (channel_key, plan_date, rationale) VALUES ($1, $2, $3)
         ON CONFLICT (channel_key, plan_date) WHERE status = 'active' DO NOTHING`,
        [i.channelKey, i.planDate, RESERVED_ONLY_RATIONALE]);
      const plan = await client.query(
        `SELECT id FROM editor_plans WHERE channel_key = $1 AND plan_date = $2 AND status = 'active' FOR UPDATE`,
        [i.channelKey, i.planDate]);
      const { rows } = await client.query(
        `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, kind, format, topic, source_hints, post_spec)
         VALUES ($1, $2, $3, 'reserved', $4, $5, $6, $7) RETURNING id`,
        [plan.rows[0].id, i.channelKey, i.scheduledAt, i.format, i.topic, JSON.stringify(i.sourceHints), JSON.stringify(i.postSpec)]);
      await client.query('COMMIT');
      return rows[0].id;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Atomically move due reserved (ad) slots planned → running. Executed by code, never by the LLM. */
  async claimDueReserved(now: Date, limit: number): Promise<EditorSlot[]> {
    const { rows } = await this.pool.query(
      `UPDATE editor_slots SET status = 'running', attempts = attempts + 1, updated_at = now()
        WHERE id IN (
          SELECT id FROM editor_slots
           WHERE status = 'planned' AND kind = 'reserved' AND scheduled_at <= $1
           ORDER BY scheduled_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [now, limit]);
    return rows.map(rowToSlot);
  }

  /**
   * Replace the day's plan atomically: old active plan → superseded, its
   * still-planned content slots → skipped, reserved slots move to the new plan.
   */
  async createPlan(channelKey: string, planDate: string, rationale: string, runId: string | null, slots: PlannedSlot[]): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const old = await client.query(
        `UPDATE editor_plans SET status = 'superseded' WHERE channel_key = $1 AND plan_date = $2 AND status = 'active' RETURNING id`,
        [channelKey, planDate]);
      const { rows } = await client.query(
        `INSERT INTO editor_plans (channel_key, plan_date, rationale, run_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [channelKey, planDate, rationale, runId]);
      const planId: string = rows[0].id;
      for (const o of old.rows) {
        await client.query(
          `UPDATE editor_slots SET status = 'skipped', error = 'superseded by a new plan', updated_at = now()
            WHERE plan_id = $1 AND status = 'planned' AND kind = 'content'`, [o.id]);
        await client.query(`UPDATE editor_slots SET plan_id = $2, updated_at = now() WHERE plan_id = $1 AND kind = 'reserved'`, [o.id, planId]);
      }
      for (const s of slots) {
        await client.query(
          `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, angle, source_hints, is_experiment)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [planId, channelKey, s.scheduledAt, s.format, s.topic, s.angle, JSON.stringify(s.sourceHints), s.isExperiment]);
      }
      await client.query('COMMIT');
      return planId;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Atomically move due content slots planned → running (single-instance safe, and multi-instance safe too). */
  async claimDue(now: Date, limit: number): Promise<EditorSlot[]> {
    const { rows } = await this.pool.query(
      `UPDATE editor_slots SET status = 'running', attempts = attempts + 1, updated_at = now()
        WHERE id IN (
          SELECT id FROM editor_slots
           WHERE status = 'planned' AND kind = 'content' AND scheduled_at <= $1
           ORDER BY scheduled_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [now, limit]);
    return rows.map(rowToSlot);
  }

  /** Planned slots that are more than `maxLateMs` overdue are skipped instead of posted late. */
  async skipStale(now: Date, maxLateMs: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE editor_slots SET status = 'skipped', error = 'stale: missed its time window', updated_at = now()
        WHERE status = 'planned' AND kind = 'content' AND scheduled_at < $1`,
      [new Date(now.getTime() - maxLateMs)]);
    return rowCount ?? 0;
  }

  /** Slots stuck in running (process crash mid-run) → failed. */
  async sweepStuck(now: Date, stuckMs: number): Promise<EditorSlot[]> {
    const { rows } = await this.pool.query(
      `UPDATE editor_slots SET status = 'failed', error = COALESCE(error, 'stuck in running (crash?)'), updated_at = now()
        WHERE status = 'running' AND updated_at < $1 RETURNING *`,
      [new Date(now.getTime() - stuckMs)]);
    await this.pool.query(
      `UPDATE editor_runs SET status = 'error', error = COALESCE(error, 'stuck (swept)'), finished_at = now()
        WHERE status = 'running' AND started_at < $1`,
      [new Date(now.getTime() - stuckMs)]);
    return rows.map(rowToSlot);
  }

  /**
   * Owner "run now" (006): claim ONE planned content slot regardless of its
   * time. Same transition as claimDue (planned → running, attempts+1), so the
   * scheduler can never run it a second time.
   */
  async claimSlot(id: string): Promise<EditorSlot | null> {
    const { rows } = await this.pool.query(
      `UPDATE editor_slots SET status = 'running', attempts = attempts + 1, updated_at = now()
        WHERE id = $1 AND status = 'planned' AND kind = 'content'
        RETURNING *`, [id]);
    return rows[0] ? rowToSlot(rows[0]) : null;
  }

  /** Owner skip (006): only a slot that is still planned can be skipped. */
  async skipPlannedSlot(id: string, reason: string): Promise<EditorSlot | null> {
    const { rows } = await this.pool.query(
      `UPDATE editor_slots SET status = 'skipped', error = $2, updated_at = now()
        WHERE id = $1 AND status = 'planned'
        RETURNING *`, [id, reason]);
    return rows[0] ? rowToSlot(rows[0]) : null;
  }

  /** Plans of one date (active first), each with its slots. */
  async listPlans(planDate: string, channelKey?: string | null): Promise<EditorPlan[]> {
    const { rows: plans } = await this.pool.query(
      `SELECT id, channel_key, plan_date::text AS plan_date, status, rationale, run_id, created_at FROM editor_plans
        WHERE plan_date = $1 AND ($2::text IS NULL OR channel_key = $2)
        ORDER BY channel_key, (status = 'active') DESC, created_at DESC`,
      [planDate, channelKey ?? null]);
    if (!plans.length) return [];
    const { rows: slots } = await this.pool.query(
      `SELECT * FROM editor_slots WHERE plan_id = ANY($1::uuid[]) ORDER BY scheduled_at`, [plans.map((p) => p.id)]);
    const byPlan = new Map<string, EditorSlot[]>();
    for (const r of slots) {
      const s = rowToSlot(r);
      byPlan.set(s.planId, [...(byPlan.get(s.planId) ?? []), s]);
    }
    return plans.map((p) => ({
      id: p.id, channelKey: p.channel_key, planDate: p.plan_date, status: p.status, rationale: p.rationale ?? null,
      runId: p.run_id ?? null, createdAt: p.created_at, slots: byPlan.get(p.id) ?? [],
    }));
  }

  /** Slot counts per status of every active plan dated on or after `sinceDate`. */
  async slotStatusCounts(sinceDate: string): Promise<SlotStatusCount[]> {
    const { rows } = await this.pool.query(
      `SELECT p.channel_key, p.plan_date::text AS plan_date, s.status, COUNT(*)::int AS n
         FROM editor_plans p JOIN editor_slots s ON s.plan_id = p.id
        WHERE p.status = 'active' AND p.plan_date >= $1
        GROUP BY 1, 2, 3`, [sinceDate]);
    return rows.map((r) => ({ channelKey: r.channel_key, planDate: r.plan_date, status: r.status, n: Number(r.n) }));
  }

  async getSlot(id: string): Promise<EditorSlot | null> {
    const { rows } = await this.pool.query(`SELECT * FROM editor_slots WHERE id = $1`, [id]);
    return rows[0] ? rowToSlot(rows[0]) : null;
  }

  async listSlots(channelKey: string, planId: string): Promise<EditorSlot[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM editor_slots WHERE channel_key = $1 AND plan_id = $2 ORDER BY scheduled_at`, [channelKey, planId]);
    return rows.map(rowToSlot);
  }

  async updateSlot(id: string, p: SlotResultPatch): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (p.status !== undefined)          add('status', p.status);
    if (p.runId !== undefined)           add('run_id', p.runId);
    if (p.publishedPostId !== undefined) add('published_post_id', p.publishedPostId);
    if (p.postSpec !== undefined)        add('post_spec', p.postSpec === null ? null : JSON.stringify(p.postSpec));
    if (p.renderedPreview !== undefined) add('rendered_preview', p.renderedPreview);
    if (p.error !== undefined)           add('error', p.error);
    if (p.scheduledAt !== undefined)     add('scheduled_at', p.scheduledAt);
    if (!sets.length) return;
    await this.pool.query(`UPDATE editor_slots SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
  }

  /** How many of the channel's most recent finished slots failed in a row. */
  async consecutiveFailures(channelKey: string): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT status FROM editor_slots WHERE channel_key = $1 AND status IN ('published','shadowed','skipped','failed')
        ORDER BY updated_at DESC LIMIT 5`, [channelKey]);
    let n = 0;
    for (const r of rows) { if (r.status === 'failed') n++; else break; }
    return n;
  }

  // ── facts the publish guards need (all channels' publications, any source) ──

  async countPublishedSince(channelKey: string, since: Date): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM published_posts WHERE channel_id = $1 AND posted_at >= $2`, [channelKey, since]);
    return rows[0]?.n ?? 0;
  }

  async lastPostAt(channelKey: string): Promise<Date | null> {
    const { rows } = await this.pool.query(`SELECT MAX(posted_at) AS at FROM published_posts WHERE channel_id = $1`, [channelKey]);
    return rows[0]?.at ? new Date(rows[0].at) : null;
  }

  async sourceAlreadyPosted(channelKey: string, sourceUrl: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM published_posts WHERE channel_id = $1 AND source_url = $2
       UNION ALL
       SELECT 1 FROM editor_slots WHERE channel_key = $1 AND status = 'shadowed'
          AND (post_spec->'source'->>'url' = $2 OR post_spec->>'library_ref' = $2)
       LIMIT 1`, [channelKey, sourceUrl]);
    return rows.length > 0;
  }

  async recentTexts(channelKey: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      `(SELECT COALESCE(rendered_preview, topic) AS text FROM editor_slots
         WHERE channel_key = $1 AND status IN ('published','shadowed') ORDER BY updated_at DESC LIMIT 60)
       UNION ALL
       (SELECT title AS text FROM published_posts
         WHERE channel_id = $1 AND title IS NOT NULL AND editor_slot_id IS NULL ORDER BY posted_at DESC LIMIT 60)`,
      [channelKey]);
    return rows.map((r) => String(r.text ?? ''));
  }

  async insertPublication(i: {
    channelKey: string; messageId: number; sourceUrl: string | null; title: string; tags: string[]; format: string; slotId: string;
    /** 'editor' for agent posts, 'ad' for reserved sponsored posts. */
    strategyType?: 'editor' | 'ad';
  }): Promise<number> {
    const { rows } = await this.pool.query(
      `INSERT INTO published_posts (channel_id, message_id, source_url, title, strategy_type, tags, format, editor_slot_id)
       VALUES ($1, $2, $3, $4, $8, $5, $6, $7)
       ON CONFLICT (channel_id, message_id) DO UPDATE SET editor_slot_id = EXCLUDED.editor_slot_id
       RETURNING id`,
      [i.channelKey, i.messageId, i.sourceUrl, i.title, i.tags, i.format, i.slotId, i.strategyType ?? 'editor']);
    return Number(rows[0].id);
  }
}
