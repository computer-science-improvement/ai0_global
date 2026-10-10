import type { Pool } from 'pg';
import { rowToSlot, RESERVED_ONLY_RATIONALE, type EditorSlot } from '../repo/editor-plans.repository';
import type { LiveSpec } from '../live/live-slot';
import { rowToRule, ruleColumns, type ScheduleRule, type ScheduleRuleInput } from './schedule-rules';

type Q = Pick<Pool, 'query'> & Partial<Pick<Pool, 'connect'>>;

/** One pin slot to materialise (spec 023 FR-004). */
export interface PinSlotInput {
  ruleId:      string;
  ruleDate:    string;
  channelKey:  string;
  /** The anchor plan date (the card's zone) the slot belongs to. */
  planDate:    string;
  scheduledAt: Date;
  /** null = the anchor Telegram channel itself. */
  resourceRef: string | null;
  format:      string;
  topic:       string;
  sourceHints: string[];
  seriesName:  string | null;
  /** Spec 034 FR-010: a pin on a feed source is a live slot. */
  live?:       LiveSpec | null;
}

/** Storage of schedule rules and their materialised pin slots. */
export class ScheduleRepository {
  constructor(private readonly pool: Q) {}

  async list(agentId: string, o: { activeOnly?: boolean } = {}): Promise<ScheduleRule[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM schedule_rules WHERE agent_id = $1 AND ($2::bool IS NOT TRUE OR active) ORDER BY kind, resource_ref, at_local NULLS LAST, created_at`,
      [agentId, o.activeOnly ?? false]);
    return rows.map(rowToRule);
  }

  /** Active rules of these resources, any agent (the planners care about the resource). */
  async activeFor(refs: string[]): Promise<ScheduleRule[]> {
    if (!refs.length) return [];
    const { rows } = await this.pool.query(`SELECT * FROM schedule_rules WHERE active AND resource_ref = ANY($1::text[]) ORDER BY created_at`, [refs]);
    return rows.map(rowToRule);
  }

  /** Every active pin (materialisation sweep). */
  async activePins(agentId?: string | null): Promise<ScheduleRule[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM schedule_rules WHERE active AND kind = 'pin' AND ($1::uuid IS NULL OR agent_id = $1) ORDER BY created_at`, [agentId ?? null]);
    return rows.map(rowToRule);
  }

  async get(id: string): Promise<ScheduleRule | null> {
    const { rows } = await this.pool.query(`SELECT * FROM schedule_rules WHERE id = $1`, [id]);
    return rows[0] ? rowToRule(rows[0]) : null;
  }

  async insert(agentId: string, i: ScheduleRuleInput, createdBy: 'owner' | 'chat'): Promise<ScheduleRule> {
    const c = ruleColumns(i);
    const { rows } = await this.pool.query(
      `INSERT INTO schedule_rules (agent_id, resource_ref, kind, days, at_local, until_local, window_min, format, series_name, brief, source,
                                   per_day_min, per_day_max, valid_from, valid_until, note, created_by)
       VALUES ($1, $2, $3, $4::smallint[], $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
      [agentId, c.resource_ref, c.kind, c.days, c.at_local, c.until_local, c.window_min, c.format, c.series_name, c.brief,
        c.source == null ? null : JSON.stringify(c.source), c.per_day_min, c.per_day_max, c.valid_from, c.valid_until, c.note, createdBy]);
    return rowToRule(rows[0]);
  }

  /** Replace a rule's fields (the merged input) and/or its active flag. */
  async update(id: string, i: ScheduleRuleInput, active: boolean): Promise<ScheduleRule | null> {
    const c = ruleColumns(i);
    const { rows } = await this.pool.query(
      `UPDATE schedule_rules SET resource_ref = $2, kind = $3, days = $4::smallint[], at_local = $5, until_local = $6, window_min = $7, format = $8,
              series_name = $9, brief = $10, source = $11, per_day_min = $12, per_day_max = $13, valid_from = $14, valid_until = $15, note = $16,
              active = $17, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, c.resource_ref, c.kind, c.days, c.at_local, c.until_local, c.window_min, c.format, c.series_name, c.brief,
        c.source == null ? null : JSON.stringify(c.source), c.per_day_min, c.per_day_max, c.valid_from, c.valid_until, c.note, active]);
    return rows[0] ? rowToRule(rows[0]) : null;
  }

  /**
   * A changed or disabled pin: its future, not yet written slots go (so the new version can be materialised;
   * written, published or skipped ones stay as history).
   */
  async dropFuturePins(ruleId: string, now: Date): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM editor_slots WHERE schedule_rule_id = $1 AND status = 'planned' AND scheduled_at > $2`, [ruleId, now]);
    return rowCount ?? 0;
  }

  /**
   * Materialise one pin as a content slot of the anchor's active plan for its date — once per (rule, date):
   * the unique index makes a rerun a no-op. A day without a plan gets a reserved-only plan, so the scheduler
   * still runs the planner, which keeps the pin (createPlan moves it to the new plan).
   */
  async materialise(p: PinSlotInput): Promise<string | null> {
    const conn = this.pool.connect ? await this.pool.connect() : null;
    const q = conn ?? this.pool;
    try {
      if (conn) await conn.query('BEGIN');
      await q.query(
        `INSERT INTO editor_plans (channel_key, plan_date, rationale) VALUES ($1, $2, $3)
         ON CONFLICT (channel_key, plan_date) WHERE status = 'active' DO NOTHING`, [p.channelKey, p.planDate, RESERVED_ONLY_RATIONALE]);
      const plan = await q.query(`SELECT id FROM editor_plans WHERE channel_key = $1 AND plan_date = $2 AND status = 'active' FOR UPDATE`, [p.channelKey, p.planDate]);
      const { rows } = await q.query(
        `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, kind, format, topic, source_hints, is_experiment, resource_ref,
                                   schedule_rule_id, rule_date, series_name, topic_mode, live_spec)
         VALUES ($1, $2, $3, 'content', $4, $5, $6, false, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (schedule_rule_id, rule_date) WHERE schedule_rule_id IS NOT NULL DO NOTHING RETURNING id`,
        [plan.rows[0].id, p.channelKey, p.scheduledAt, p.format, p.topic, JSON.stringify(p.sourceHints), p.resourceRef, p.ruleId, p.ruleDate, p.seriesName,
          p.live ? 'live' : 'fixed', p.live ? JSON.stringify(p.live) : null]);
      if (conn) await conn.query('COMMIT');
      return rows[0]?.id ?? null;
    } catch (err) {
      if (conn) await conn.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      conn?.release();
    }
  }

  /** Active-plan slots of an anchor channel in [from, to) (content, reserved and pins; every status). */
  async slotsBetween(channelKey: string, from: Date, to: Date): Promise<EditorSlot[]> {
    const { rows } = await this.pool.query(
      `SELECT s.* FROM editor_slots s JOIN editor_plans p ON p.id = s.plan_id
        WHERE s.channel_key = $1 AND p.status = 'active' AND s.scheduled_at >= $2 AND s.scheduled_at < $3
        ORDER BY s.scheduled_at`, [channelKey, from, to]);
    return rows.map(rowToSlot);
  }

  /** Materialised pins of an anchor channel in [from, to) that are still to run or done (not skipped). */
  async pinsBetween(channelKey: string, from: Date, to: Date): Promise<EditorSlot[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM editor_slots WHERE channel_key = $1 AND schedule_rule_id IS NOT NULL AND status NOT IN ('skipped','failed','expired')
          AND scheduled_at >= $2 AND scheduled_at < $3 ORDER BY scheduled_at`, [channelKey, from, to]);
    return rows.map(rowToSlot);
  }

  /**
   * Spec 034 FR-011: content slots of the day's active plan that a replan keeps (not pins — they are
   * `pinsOn`; not repurposed posts): running, written, due within `keepUntil`, and news-watch slots.
   * The planners treat them as fixed points (count, gap, series) like pins.
   */
  async keptOn(channelKey: string, planDate: string, keepUntil: Date): Promise<EditorSlot[]> {
    const { rows } = await this.pool.query(
      `SELECT s.* FROM editor_slots s JOIN editor_plans p ON p.id = s.plan_id
        WHERE p.channel_key = $1 AND p.plan_date = $2::date AND p.status = 'active'
          AND s.kind = 'content' AND s.schedule_rule_id IS NULL AND COALESCE(s.source_post->>'via', '') <> 'repurpose'
          AND (s.status IN ('running','awaiting_approval','approved','published','shadowed')
            OR (s.status = 'planned' AND (s.scheduled_at <= $3 OR COALESCE(s.live_spec->>'origin', '') = 'news_watch')))
        ORDER BY s.scheduled_at`, [channelKey, planDate, keepUntil]);
    return rows.map(rowToSlot);
  }

  /** Materialised pins of an anchor channel whose resource-local date is `date` (not skipped / failed). */
  async pinsOn(channelKey: string, date: string): Promise<EditorSlot[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM editor_slots WHERE channel_key = $1 AND schedule_rule_id IS NOT NULL AND rule_date = $2::date
          AND status NOT IN ('skipped','failed','expired') ORDER BY scheduled_at`, [channelKey, date]);
    return rows.map(rowToSlot);
  }

  /** Move a planned content slot (owner card); null when it is not planned at that time any more. */
  async moveSlot(id: string, from: Date, to: Date): Promise<EditorSlot | null> {
    const { rows } = await this.pool.query(
      `UPDATE editor_slots SET scheduled_at = $3, updated_at = now() WHERE id = $1 AND status = 'planned' AND kind = 'content' AND scheduled_at = $2 RETURNING *`,
      [id, from, to]);
    return rows[0] ? rowToSlot(rows[0]) : null;
  }

  async skipSlot(id: string, from: Date, reason: string): Promise<EditorSlot | null> {
    const { rows } = await this.pool.query(
      `UPDATE editor_slots SET status = 'skipped', error = $3, updated_at = now() WHERE id = $1 AND status = 'planned' AND kind = 'content' AND scheduled_at = $2 RETURNING *`,
      [id, from, reason]);
    return rows[0] ? rowToSlot(rows[0]) : null;
  }
}
