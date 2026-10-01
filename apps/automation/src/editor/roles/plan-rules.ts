import { z } from 'zod';
import type { EditorCard } from '../card';
import { SUPPORTED_FORMATS } from '../post/post-spec';
import { isQuietHour, zonedToUtc } from './time';

export const PlanSlotInput = z.object({
  time:          z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).describe('Локальний час каналу HH:MM'),
  format:        z.string().min(1).max(20),
  topic:         z.string().min(5).max(300).describe('Конкретна тема поста'),
  angle:         z.string().max(400).optional().describe('Кут подачі / що саме підкреслити'),
  source_hints:  z.array(z.string().max(300)).max(5).default([]).describe('id джерел з картки, таблиці бібліотеки (library:recipes) або URL'),
  is_experiment: z.boolean().default(false),
  idea_id:       z.string().uuid().optional().describe('id прийнятої ідеї з пулу (list_ideas), якщо слот її реалізує'),
});
export const SubmitPlanInput = z.object({
  rationale: z.string().min(10).max(1500),
  slots:     z.array(PlanSlotInput).max(24),
});
export type SubmitPlan = z.infer<typeof SubmitPlanInput>;

export interface PlannedSlot {
  scheduledAt:  Date;
  format:       string;
  topic:        string;
  angle:        string | null;
  sourceHints:  string[];
  isExperiment: boolean;
  ideaId?:      string | null;
}

export type PlanVerdict = { ok: true; slots: PlannedSlot[] } | { ok: false; errors: string[] };

const LEAD_MINUTES = 5;

/** How many slots still fit into the rest of `planDate` (non-quiet, min-gap spaced) — so a late start isn't forced to hit posts_per_day_min. */
export function remainingCapacity(
  card: Pick<EditorCard, 'timezone' | 'quietStartHour' | 'quietEndHour' | 'minGapMinutes'>,
  planDate: string,
  now: Date,
): number {
  const end = zonedToUtc(planDate, '23:59', card.timezone).getTime();
  const step = Math.max(card.minGapMinutes, 1) * 60_000;
  let n = 0;
  for (let t = Math.max(now.getTime() + LEAD_MINUTES * 60_000, zonedToUtc(planDate, '00:00', card.timezone).getTime()); t <= end; t += 60_000) {
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: card.timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(t)));
    if (!isQuietHour(hour, card.quietStartHour, card.quietEndHour)) { n++; t += step - 60_000; }
  }
  return n;
}

/**
 * Deterministic validation of a planner's day plan. Every rule here is a hard
 * guarantee the model cannot talk its way around; violations go back to the
 * model as a list so it can fix the plan and resubmit.
 */
export function validatePlan(
  plan: SubmitPlan,
  card: Pick<EditorCard, 'timezone' | 'postsPerDayMin' | 'postsPerDayMax' | 'quietStartHour' | 'quietEndHour' | 'minGapMinutes' | 'formats' | 'exploreRatio'>,
  planDate: string,
  now: Date,
  reservedAt: Date[] = [],
): PlanVerdict {
  const errors: string[] = [];
  const n = plan.slots.length;
  const total = n + reservedAt.length;
  const minToday = Math.min(card.postsPerDayMin, remainingCapacity(card, planDate, now) + reservedAt.length);
  if (total < minToday || total > card.postsPerDayMax) {
    errors.push(`кількість постів (з резервними: ${reservedAt.length}) має бути ${minToday}–${card.postsPerDayMax}, зараз ${total}`);
  }

  const allowed = new Set(Object.entries(card.formats).filter(([f, w]) => Number(w) > 0 && (SUPPORTED_FORMATS as readonly string[]).includes(f)).map(([f]) => f));
  const maxExperiments = Math.ceil(card.exploreRatio * n);
  const experiments = plan.slots.filter((s) => s.is_experiment).length;
  if (experiments > maxExperiments) errors.push(`експериментів ${experiments}, максимум ${maxExperiments} (explore_ratio ${card.exploreRatio})`);

  const gapMs = card.minGapMinutes * 60_000;
  const slots: PlannedSlot[] = [];
  let prev: Date | null = null;
  plan.slots.forEach((s, i) => {
    const at = zonedToUtc(planDate, s.time, card.timezone);
    const label = `слот ${i + 1} (${s.time})`;
    if (!allowed.has(s.format)) errors.push(`${label}: формат ${s.format} не дозволений; дозволені: ${[...allowed].join(', ')}`);
    if (at.getTime() < now.getTime() + LEAD_MINUTES * 60_000) errors.push(`${label}: час уже минув або менше ніж через ${LEAD_MINUTES} хв`);
    const hour = Number(s.time.slice(0, 2));
    if (isQuietHour(hour, card.quietStartHour, card.quietEndHour)) errors.push(`${label}: тихі години ${card.quietStartHour}:00–${card.quietEndHour}:00`);
    if (prev && at.getTime() <= prev.getTime()) errors.push(`${label}: слоти мають іти за зростанням часу`);
    else if (prev && at.getTime() - prev.getTime() < gapMs) errors.push(`${label}: інтервал з попереднім < ${card.minGapMinutes} хв`);
    for (const r of reservedAt) {
      if (Math.abs(at.getTime() - r.getTime()) < gapMs) errors.push(`${label}: занадто близько до резервного слоту`);
    }
    prev = at;
    slots.push({ scheduledAt: at, format: s.format, topic: s.topic, angle: s.angle ?? null, sourceHints: s.source_hints, isExperiment: s.is_experiment, ...(s.idea_id ? { ideaId: s.idea_id } : {}) });
  });

  return errors.length ? { ok: false, errors } : { ok: true, slots };
}
