import { z } from 'zod';
import type { EditorCard } from '../card';
import { CAPABILITIES } from '../platform/capabilities';
import { isQuietHour, zonedToUtc } from '../roles/time';
import type { IdeaRow } from './network.repository';
import type { NetworkCtx } from './network-context';
import { seriesDue } from './playbook';

export const NetworkSlotInput = z.object({
  resource_ref: z.string().min(3).max(200),
  time:         z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).describe('HH:MM за Києвом'),
  format:       z.string().min(2).max(30),
  topic:        z.string().min(5).max(300),
  angle:        z.string().max(400).optional(),
  idea_id:      z.string().uuid().optional(),
  series:       z.string().max(80).optional().describe('Назва серії з плейбука, якщо це її випуск'),
  note:         z.string().max(400).optional(),
  source_hints: z.array(z.string().max(300)).max(5).default([]),
});
export const SubmitNetworkPlanInput = z.object({
  rationale: z.string().min(10).max(2000),
  slots:     z.array(NetworkSlotInput).max(60),
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
}

export const IDEA_VARIANT_GAP_MIN = 90;
export const PLATFORM_GAP_MIN = 60;
const LEAD_MIN = 5;

/**
 * Deterministic validation of a network day plan (spec 020 FR-007). Errors go
 * back to the planner as Ukrainian lines so it can fix and resubmit.
 */
export function validateNetworkPlan(
  plan: SubmitNetworkPlan,
  o: {
    net: NetworkCtx;
    card: Pick<EditorCard, 'timezone' | 'quietStartHour' | 'quietEndHour' | 'minGapMinutes'>;
    planDate: string;
    weekday: number;
    now: Date;
    ideas: Map<string, IdeaRow>;
    reservedAt: Date[];
  },
): { ok: true; slots: NetworkPlannedSlot[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const { net, card } = o;
  if (!net.playbook) return { ok: false, errors: ['немає активного плейбука — план мережі неможливий'] };
  const sections = new Map(net.playbook.platforms.map((s) => [s.resource_ref, s]));
  const resources = new Map(net.resources.map((r) => [r.ref, r]));
  const due = new Map(seriesDue(net.playbook, o.weekday).map((x) => [x.series.name, x]));
  const out: NetworkPlannedSlot[] = [];
  const byResource = new Map<string, NetworkPlannedSlot[]>();
  const byIdea = new Map<string, NetworkPlannedSlot[]>();

  plan.slots.forEach((s, i) => {
    const label = `слот ${i + 1} (${s.resource_ref} ${s.time})`;
    const r = resources.get(s.resource_ref);
    const sec = sections.get(s.resource_ref);
    if (!r) { errors.push(`${label}: ресурс не в мережі або недоступний (є: ${[...resources.keys()].join(', ')})`); return; }
    if (!sec) { errors.push(`${label}: у плейбуку немає секції цього ресурсу`); return; }
    if (!(sec.formats[s.format] > 0)) errors.push(`${label}: формат ${s.format} не дозволений плейбуком (є: ${Object.keys(sec.formats).filter((f) => sec.formats[f] > 0).join(', ')})`);
    const at = zonedToUtc(o.planDate, s.time, card.timezone);
    if (at.getTime() < o.now.getTime() + LEAD_MIN * 60_000) errors.push(`${label}: час уже минув`);
    if (isQuietHour(Number(s.time.slice(0, 2)), card.quietStartHour, card.quietEndHour)) errors.push(`${label}: тихі години`);
    if (r.platform === 'telegram') {
      for (const x of o.reservedAt) if (Math.abs(x.getTime() - at.getTime()) < card.minGapMinutes * 60_000) errors.push(`${label}: занадто близько до резервного (рекламного) слоту`);
    }
    if (s.idea_id) {
      const idea = o.ideas.get(s.idea_id);
      if (!idea) errors.push(`${label}: ідея ${s.idea_id} не знайдена або не прийнята рецензентом`);
      else if (!idea.variants.some((v) => v.resource_ref === s.resource_ref)) errors.push(`${label}: в ідеї немає варіанта для цього ресурсу`);
    }
    if (s.series && !due.has(s.series)) errors.push(`${label}: серія «${s.series}» сьогодні не за розкладом або неактивна`);
    if (!s.idea_id && !s.series) errors.push(`${label}: потрібен idea_id (прийнята ідея) або series`);
    const slot: NetworkPlannedSlot = {
      resourceRef: s.resource_ref, scheduledAt: at, format: s.format, topic: s.topic,
      angle: [s.angle, s.note].filter(Boolean).join(' · ') || null, ideaId: s.idea_id ?? null,
      sourceHints: s.series ? [`series:${s.series}`, ...s.source_hints] : s.source_hints,
    };
    out.push(slot);
    byResource.set(s.resource_ref, [...(byResource.get(s.resource_ref) ?? []), slot]);
    if (s.idea_id) byIdea.set(s.idea_id, [...(byIdea.get(s.idea_id) ?? []), slot]);
  });

  for (const [ref, slots] of byResource) {
    const sec = sections.get(ref)!;
    const platform = resources.get(ref)!.platform;
    const reservedHere = platform === 'telegram' ? o.reservedAt.length : 0;
    if (slots.length + reservedHere > sec.per_day.max) errors.push(`${ref}: ${slots.length + reservedHere} постів > per_day.max ${sec.per_day.max}`);
    if (platform !== 'telegram' && slots.length > CAPABILITIES[platform].dailyApiCap) errors.push(`${ref}: понад ліміт API платформи`);
    const gap = (platform === 'telegram' ? card.minGapMinutes : PLATFORM_GAP_MIN) * 60_000;
    const sorted = [...slots].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].scheduledAt.getTime() - sorted[i - 1].scheduledAt.getTime() < gap) errors.push(`${ref}: інтервал між постами менше ${gap / 60_000} хв`);
    }
  }
  for (const [ref, sec] of sections) {
    if (!resources.has(ref)) continue;
    const n = (byResource.get(ref)?.length ?? 0) + (resources.get(ref)!.platform === 'telegram' ? o.reservedAt.length : 0);
    if (n < sec.per_day.min) errors.push(`${ref}: ${n} постів < per_day.min ${sec.per_day.min}`);
  }
  for (const [id, slots] of byIdea) {
    const refs = slots.map((s) => s.resourceRef);
    // A planned idea goes to every resource it has a variant for, while that resource still has room today.
    const idea = o.ideas.get(id);
    for (const v of idea?.variants ?? []) {
      if (refs.includes(v.resource_ref) || !resources.has(v.resource_ref)) continue;
      const sec = sections.get(v.resource_ref);
      const used = byResource.get(v.resource_ref)?.length ?? 0;
      if (sec && used < sec.per_day.max && sec.formats[v.format] > 0) {
        errors.push(`ідея ${id}: не заплановано варіант для ${v.resource_ref} (${v.format}) — додай слот (≥ ${IDEA_VARIANT_GAP_MIN} хв після попереднього варіанта)`);
      }
    }
    if (new Set(refs).size !== refs.length) errors.push(`ідея ${id}: два варіанти на одному ресурсі`);
    const sorted = [...slots].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].scheduledAt.getTime() - sorted[i - 1].scheduledAt.getTime() < IDEA_VARIANT_GAP_MIN * 60_000) {
        errors.push(`ідея ${id}: варіанти мають іти з інтервалом ≥ ${IDEA_VARIANT_GAP_MIN} хв`);
      }
    }
    const tg = sorted.find((s) => resources.get(s.resourceRef)?.platform === 'telegram');
    const tgSection = tg ? sections.get(tg.resourceRef) : null;
    if (tg && tgSection?.role === 'core' && sorted[0] !== tg) errors.push(`ідея ${id}: Telegram (core) має бути першим`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, slots: out };
}
