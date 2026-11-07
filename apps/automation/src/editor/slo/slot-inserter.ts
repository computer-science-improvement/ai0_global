/**
 * Spec 091 FR-003: the one place that puts a controller slot (a replacement or a dark-recovery slot) into a channel's plan.
 * The rung planner and dark recovery call it; neither touches the plan tables.
 */
import type { Pool } from 'pg';
import type { EditorCard } from '../card';
import { RESERVED_ONLY_RATIONALE } from '../repo/editor-plans.repository';
import { localDate, zonedToUtc } from '../roles/time';
import { earliestFreeTime, ACTIVE_SLOT_STATUSES } from './slot-time';
import type { ReplacementSpec, SlotInserter, SloSlotMark } from './types';

type Env = (k: string) => string | undefined;

export const DEFAULT_REPLACEMENT_LEAD_MIN = 15;
/** A chain of replacements stops at this depth: one try and one retry (FR-003). */
export const MAX_REPLACEMENT_DEPTH = 2;

/** SLO_REPLACEMENT_LEAD_MIN, 5-240, read at call time. */
export function replacementLeadMin(env: Env): number {
  const n = Number(env('SLO_REPLACEMENT_LEAD_MIN')?.trim());
  return Number.isFinite(n) && n > 0 ? Math.min(240, Math.max(5, Math.round(n))) : DEFAULT_REPLACEMENT_LEAD_MIN;
}

export interface SlotInserterDeps {
  pool: Pick<Pool, 'query'> & Partial<Pick<Pool, 'connect'>>;
  env:  Env;
  log?: (m: string) => void;
}

export class SloSlotInserter implements SlotInserter {
  constructor(private readonly d: SlotInserterDeps) {}

  async insert(card: EditorCard, spec: ReplacementSpec, mark: SloSlotMark, now: Date): Promise<string | null> {
    if (mark.depth > MAX_REPLACEMENT_DEPTH) return null;
    const day = localDate(now, card.timezone);
    const at = await earliestFreeTime(this.d.pool, card, day, now, replacementLeadMin(this.d.env));
    if (!at) return null;
    // The day's maximum is a hard card rule: a replacement fills a gap, it does not stack on top of a full day.
    const from = zonedToUtc(day, '00:00', card.timezone);
    const to = new Date(from.getTime() + 86_400_000);
    const { rows: cnt } = await this.d.pool.query(
      `SELECT count(*)::int AS n FROM editor_slots
        WHERE channel_key = $1 AND kind = 'content' AND resource_ref IS NULL AND status IN ${ACTIVE_SLOT_STATUSES}
          AND scheduled_at >= $2 AND scheduled_at < $3`, [card.channelKey, from, to]);
    if (Number(cnt[0]?.n ?? 0) >= card.postsPerDayMax) return null;

    // The day's active plan; a day without one gets the placeholder plan the planner still replaces (reserved slots do the same).
    await this.d.pool.query(
      `INSERT INTO editor_plans (channel_key, plan_date, rationale) VALUES ($1, $2, $3)
       ON CONFLICT (channel_key, plan_date) WHERE status = 'active' DO NOTHING`, [card.channelKey, day, RESERVED_ONLY_RATIONALE]);
    const { rows: plan } = await this.d.pool.query(
      `SELECT id FROM editor_plans WHERE channel_key = $1 AND plan_date = $2 AND status = 'active'`, [card.channelKey, day]);
    if (!plan[0]) return null;

    const live = spec.topicMode === 'live' && spec.live ? spec.live : null;
    const { rows } = await this.d.pool.query(
      `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, kind, format, topic, angle, source_hints, is_experiment, idea_id,
                                 topic_mode, live_spec, series_name, replaces_slot_id, slo)
       VALUES ($1, $2, $3, 'content', $4, $5, $6, $7, false, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (replaces_slot_id) WHERE replaces_slot_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [plan[0].id, card.channelKey, at, spec.format, spec.topic.slice(0, 300), spec.angle?.slice(0, 400) ?? null,
        JSON.stringify(spec.sourceHints ?? []), spec.ideaId ?? null, live ? 'live' : 'fixed', live ? JSON.stringify(live) : null,
        spec.seriesName ?? null, mark.replaces, JSON.stringify(mark)]);
    return rows[0]?.id ?? null;
  }
}
