import type { Pool } from 'pg';
import { audienceCapsOfProfile, isPollFormat, POLL_FORMATS } from '../post/audience-asks';
import { zonedToUtc } from './time';

/**
 * Spec 034 FR-005: the poll cap in the plan validators (single-channel `validatePlan` and the network
 * `validateNetworkPlan` each call `pollCapErrors` with one line). A resource gets at most `polls_per_week`
 * poll + quiz posts in the 7 days ending on the plan date: the ones already published or planned on the 6
 * days before (and the ones on the plan date a new plan does not replace) plus the plan's own.
 * Instances of a series the owner created or a strategy migration brought (origin owner / migration, or
 * locked) are the owner's choice and do not count.
 */

export const POLL_WINDOW_DAYS = 7;

export interface PollCapCtx {
  /** resource_ref → polls per week (null = no cap). A resource missing here gets the default (1). */
  caps:    Record<string, number | null>;
  /** Poll/quiz slots already in the window (see `SqlPollCaps.recent`), with the series they belong to. */
  recent:  Array<{ resourceRef: string; series: string | null }>;
  /** The resource of slots without one (the single planner's channel). */
  defaultRef?: string;
}

export interface PollSlotLike { resourceRef?: string | null; format: string; series?: string | null; sourceHints?: string[] }
export interface SeriesLike { name: string; origin?: string; locked?: boolean }

/** Series whose instances do not count against the cap: created by the owner or by a strategy migration. */
export function exemptSeries(series: readonly SeriesLike[] = []): Set<string> {
  return new Set(series.filter((s) => s.origin === 'owner' || s.origin === 'migration' || s.locked).map((s) => s.name));
}

const seriesOf = (s: PollSlotLike) => s.series ?? s.sourceHints?.find((h) => h.startsWith('series:'))?.slice('series:'.length) ?? null;

/** Ukrainian errors for the planner (empty = within the caps). */
export function pollCapErrors(slots: readonly PollSlotLike[], ctx: PollCapCtx, series: readonly SeriesLike[] = []): string[] {
  const exempt = exemptSeries(series);
  const counts = (s: { series: string | null }) => !s.series || !exempt.has(s.series);
  const planned = new Map<string, number>();
  for (const s of slots) {
    if (!isPollFormat(s.format)) continue;
    const ref = s.resourceRef ?? ctx.defaultRef ?? '';
    if (!counts({ series: seriesOf(s) })) continue;
    planned.set(ref, (planned.get(ref) ?? 0) + 1);
  }
  const errors: string[] = [];
  for (const [ref, inPlan] of planned) {
    const cap = ref in ctx.caps ? ctx.caps[ref] : 1;
    if (cap === null) continue;
    const before = ctx.recent.filter((r) => r.resourceRef === ref && counts(r)).length;
    if (before + inPlan > cap) {
      errors.push(`${ref}: опитувань і вікторин за ${POLL_WINDOW_DAYS} днів було б ${before + inPlan} (уже ${before}, у плані ${inPlan}) — ліміт ресурсу ${cap} на тиждень (polls_per_week). Заміни зайві poll/quiz на text чи photo або прибери їх; підвищити ліміт може лише власник.`);
    }
  }
  return errors;
}

/** First local day of the window for a plan date (YYYY-MM-DD). */
export function windowStartDate(planDate: string): string {
  const d = new Date(`${planDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (POLL_WINDOW_DAYS - 1));
  return d.toISOString().slice(0, 10);
}

/**
 * Loads the caps (resource_profiles) and the poll/quiz slots already in the window (editor_slots). Counted:
 * every status except skipped / failed / expired on the 6 days before the plan date; on the plan date only
 * what a new plan keeps (published, running, written, pins, reserved and repurposed slots).
 */
export class SqlPollCaps {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async load(o: { refs: string[]; planDate: string; tz: string; defaultRef?: string }): Promise<PollCapCtx> {
    const refs = [...new Set(o.refs)];
    if (!refs.length) return { caps: {}, recent: [], defaultRef: o.defaultRef };
    const profiles = await this.pool.query(`SELECT resource_ref, profile FROM resource_profiles WHERE resource_ref = ANY($1::text[])`, [refs]);
    const caps: Record<string, number | null> = {};
    for (const ref of refs) caps[ref] = audienceCapsOfProfile(profiles.rows.find((r) => r.resource_ref === ref)?.profile ?? null).pollsPerWeek;
    const from = zonedToUtc(windowStartDate(o.planDate), '00:00', o.tz);
    const dayStart = zonedToUtc(o.planDate, '00:00', o.tz);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const { rows } = await this.pool.query(
      `SELECT COALESCE(s.resource_ref, 'telegram:' || s.channel_key) AS ref,
              (SELECT substr(h, 8) FROM jsonb_array_elements_text(COALESCE(s.source_hints, '[]'::jsonb)) h WHERE h LIKE 'series:%' LIMIT 1) AS series
         FROM editor_slots s
        WHERE s.format = ANY($2::text[])
          AND COALESCE(s.resource_ref, 'telegram:' || s.channel_key) = ANY($1::text[])
          AND s.status NOT IN ('skipped', 'failed', 'expired')
          AND s.scheduled_at >= $3 AND s.scheduled_at < $5
          AND NOT (s.scheduled_at >= $4 AND s.kind = 'content' AND s.status IN ('planned', 'awaiting_approval')
                   AND s.schedule_rule_id IS NULL AND COALESCE(s.source_post->>'via', '') <> 'repurpose')`,
      [refs, [...POLL_FORMATS], from, dayStart, dayEnd]);
    return { caps, recent: rows.map((r) => ({ resourceRef: r.ref, series: r.series ?? null })), defaultRef: o.defaultRef };
  }
}
