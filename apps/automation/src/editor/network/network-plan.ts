import { z } from 'zod';
import type { EditorCard } from '../card';
import { CAPABILITIES } from '../platform/capabilities';
import { isQuietHour } from '../roles/time';
import { zonedToUtcStrict } from '../time/resource-time';
import type { IdeaRow } from './network.repository';
import { NetworkCtx, resourceClock } from './network-context';
import { seriesDue } from './playbook';
import { DecisionReason, DecisionSlot, PlannedDecision, PlanSkipInput, TREATMENTS, validateDecisions } from './plan-decisions';
import type { Treatment } from '../post/duplicate';

export const NetworkSlotInput = z.object({
  resource_ref: z.string().min(3).max(200),
  time:         z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).describe('HH:MM у часовому поясі цього ресурсу на дату плану'),
  format:       z.string().min(2).max(30),
  topic:        z.string().min(5).max(300),
  angle:        z.string().max(400).optional(),
  idea_id:      z.string().uuid().optional(),
  series:       z.string().max(80).optional().describe('Назва серії з плейбука, якщо це її випуск'),
  note:         z.string().max(400).optional(),
  source_hints: z.array(z.string().max(300)).max(5).default([]),
  // Spec 024 FR-006: what this slot is for its resource.
  treatment:    z.enum(TREATMENTS).optional().describe('За замовчуванням unique. unique — свій пост; duplicate — той самий пост джерела (ти оформлюєш його під ресурс); adapt — та сама ідея, переписана під платформу'),
  from_slot:    z.number().int().min(1).max(60).optional().describe('Для duplicate/adapt: номер (з 1) унікального слота-джерела цієї ж ідеї в цьому плані'),
  reason:       DecisionReason.optional().describe("Обов'язково з idea_id: чому таке рішення для цього ресурсу (профіль, плейбук, KPI)"),
  format_notes: z.string().max(500).optional().describe('Для duplicate/adapt: твої інструкції оформлення під цей ресурс'),
});
export const SubmitNetworkPlanInput = z.object({
  rationale: z.string().min(10).max(2000),
  slots:     z.array(NetworkSlotInput).max(60),
  skips:     z.array(PlanSkipInput).max(60).optional().describe('Ідея з плану НЕ йде на ресурс: причина обовʼязкова'),
});
export type SubmitNetworkPlan = z.infer<typeof SubmitNetworkPlanInput>;

export interface NetworkPlannedSlot {
  resourceRef:  string;
  scheduledAt:  Date;
  format:       string;
  topic:        string;
  angle:        string | null;
  ideaId:       string | null;
  sourceHints:  string[];
  /** Spec 024: unique / duplicate / adapt (single-channel plans leave it unset). */
  treatment?:   Treatment;
  treatmentReason?: string | null;
  /** Derived slots: index into the returned `slots` of their unique source. */
  fromIndex?:   number | null;
  formatNotes?: string | null;
}

const LEAD_MIN = 5;

/**
 * Deterministic validation of a network day plan (spec 020 FR-007). Errors go
 * back to the planner as Ukrainian lines so it can fix and resubmit.
 * Spec 024 FR-005: a slot's time, quiet hours and per_day are in the slot
 * resource's own zone on the plan date; a time in the spring DST gap is an
 * error, an ambiguous autumn time is the earlier instant.
 */
export function validateNetworkPlan(
  plan: SubmitNetworkPlan,
  o: {
    net: NetworkCtx;
    card: Pick<EditorCard, 'channelKey' | 'timezone' | 'quietStartHour' | 'quietEndHour' | 'minGapMinutes'>;
    planDate: string;
    weekday: number;
    now: Date;
    ideas: Map<string, IdeaRow>;
    reservedAt: Date[];
    /** Spec 024: (idea → resources) already decided outside this planner (repurpose_post, owner). */
    decided?: Map<string, Set<string>>;
  },
): { ok: true; slots: NetworkPlannedSlot[]; decisions: PlannedDecision[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const { net, card } = o;
  if (!net.playbook) return { ok: false, errors: ['немає активного плейбука — план мережі неможливий'] };
  const sections = new Map(net.playbook.platforms.map((s) => [s.resource_ref, s]));
  const resources = new Map(net.resources.map((r) => [r.ref, r]));
  const due = new Map(seriesDue(net.playbook, o.weekday).map((x) => [x.series.name, x]));
  const out: NetworkPlannedSlot[] = [];
  const byResource = new Map<string, NetworkPlannedSlot[]>();
  // Spec 024 FR-006: the decision rules see every submitted slot by its index.
  const decisionSlots: DecisionSlot[] = [];
  const outIndex = new Map<number, number>();

  plan.slots.forEach((s, i) => {
    const label = `слот ${i + 1} (${s.resource_ref} ${s.time})`;
    const r = resources.get(s.resource_ref);
    const sec = sections.get(s.resource_ref);
    if (!r) { errors.push(`${label}: ресурс не в мережі або недоступний (є: ${[...resources.keys()].join(', ')})`); return; }
    if (!sec) { errors.push(`${label}: у плейбуку немає секції цього ресурсу`); return; }
    const treatment = s.treatment ?? 'unique';
    decisionSlots[i] = {
      resourceRef: s.resource_ref, platform: r.platform, format: s.format, ideaId: s.idea_id ?? null, series: s.series ?? null,
      treatment, fromSlot: s.from_slot ?? null, reason: s.reason ?? null, at: null,
    };
    // A unique slot's format must be in the playbook; a derived slot only has to be possible on the platform (plan-decisions).
    if (treatment === 'unique' && !(sec.formats[s.format] > 0)) errors.push(`${label}: формат ${s.format} не дозволений плейбуком (є: ${Object.keys(sec.formats).filter((f) => sec.formats[f] > 0).join(', ')})`);
    const { tz, quiet } = resourceClock(r, card);
    const at = zonedToUtcStrict(o.planDate, s.time, tz);
    if (!at) { errors.push(`${label}: ${s.time} не існує ${o.planDate} у ${tz} (перехід на літній час) — обери інший час`); return; }
    decisionSlots[i].at = at;
    if (at.getTime() < o.now.getTime() + LEAD_MIN * 60_000) errors.push(`${label}: час уже минув`);
    if (isQuietHour(Number(s.time.slice(0, 2)), quiet.start, quiet.end)) errors.push(`${label}: тихі години ${quiet.start}:00–${quiet.end}:00 (${tz})`);
    if (r.platform === 'telegram') {
      for (const x of o.reservedAt) if (Math.abs(x.getTime() - at.getTime()) < card.minGapMinutes * 60_000) errors.push(`${label}: занадто близько до резервного (рекламного) слоту`);
    }
    if (s.idea_id) {
      const idea = o.ideas.get(s.idea_id);
      // Spec 024: the idea's variants are hints, not a requirement.
      if (!idea) errors.push(`${label}: ідея ${s.idea_id} не знайдена або не прийнята рецензентом`);
    }
    if (s.series && !due.has(s.series)) errors.push(`${label}: серія «${s.series}» сьогодні не за розкладом або неактивна`);
    if (!s.idea_id && !s.series) errors.push(`${label}: потрібен idea_id (прийнята ідея) або series`);
    const slot: NetworkPlannedSlot = {
      resourceRef: s.resource_ref, scheduledAt: at, format: s.format, topic: s.topic,
      angle: [s.angle, s.note].filter(Boolean).join(' · ') || null, ideaId: s.idea_id ?? null,
      sourceHints: s.series ? [`series:${s.series}`, ...s.source_hints] : s.source_hints,
      treatment, treatmentReason: s.reason ?? null, fromIndex: null, formatNotes: s.format_notes ?? null,
    };
    outIndex.set(i, out.length);
    out.push(slot);
    byResource.set(s.resource_ref, [...(byResource.get(s.resource_ref) ?? []), slot]);
  });

  for (const [ref, slots] of byResource) {
    const sec = sections.get(ref)!;
    const platform = resources.get(ref)!.platform;
    const reservedHere = platform === 'telegram' ? o.reservedAt.length : 0;
    if (slots.length + reservedHere > sec.per_day.max) errors.push(`${ref}: ${slots.length + reservedHere} постів > per_day.max ${sec.per_day.max}`);
    if (platform !== 'telegram' && slots.length > CAPABILITIES[platform].dailyApiCap) errors.push(`${ref}: понад ліміт API платформи`);
    // Spec 024 FR-013: spacing on a platform resource is the agent's choice (a prompt hint); Telegram keeps the owner's card gap.
    if (platform === 'telegram') {
      const gap = card.minGapMinutes * 60_000;
      const sorted = [...slots].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].scheduledAt.getTime() - sorted[i - 1].scheduledAt.getTime() < gap) errors.push(`${ref}: інтервал між постами менше ${gap / 60_000} хв`);
      }
    }
  }
  for (const [ref, sec] of sections) {
    if (!resources.has(ref)) continue;
    const n = (byResource.get(ref)?.length ?? 0) + (resources.get(ref)!.platform === 'telegram' ? o.reservedAt.length : 0);
    if (n < sec.per_day.min) errors.push(`${ref}: ${n} постів < per_day.min ${sec.per_day.min}`);
  }
  // Spec 024 FR-006 (replaces BR-AGT-72 and "Telegram core first"): one decision per idea × resource.
  const dec = validateDecisions(plan.slots.map((s, i) => decisionSlots[i] ?? {
    resourceRef: s.resource_ref, platform: 'telegram', format: s.format, ideaId: s.idea_id ?? null, series: s.series ?? null,
    treatment: 'unique', fromSlot: null, reason: s.reason ?? 'n/a (slot rejected above)', at: null, // already an error above
  }), plan.skips ?? [], {
    sections, resources: new Map(net.resources.map((r) => [r.ref, r.platform])), ideas: o.ideas, decided: o.decided,
    used: (ref) => (byResource.get(ref)?.length ?? 0) + (resources.get(ref)?.platform === 'telegram' ? o.reservedAt.length : 0),
  });
  errors.push(...dec.errors);
  plan.slots.forEach((s, i) => {
    const k = outIndex.get(i);
    if (k === undefined || s.from_slot == null) return;
    out[k].fromIndex = outIndex.get(s.from_slot - 1) ?? null;
  });
  const decisions = dec.decisions.map((d) => ({ ...d, slotIndex: d.slotIndex == null ? null : outIndex.get(d.slotIndex) ?? null }));
  return errors.length ? { ok: false, errors } : { ok: true, slots: out, decisions };
}
