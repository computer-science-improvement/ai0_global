import { z } from 'zod';
import type { Platform } from '../agents/agent.types';
import { derivedFormatProblem, DerivedTreatment, Treatment } from '../post/duplicate';
import type { IdeaRow } from './network.repository';
import type { PlatformSection } from './playbook';

/**
 * Spec 024 FR-006: per-resource content decisions of a network day plan.
 * Every idea in the plan gets exactly one decision per usable resource that
 * has a playbook section — a slot (unique / duplicate / adapt) or a skip with
 * a reason. Pure; validateNetworkPlan calls it after the per-slot checks.
 */

export const TREATMENTS = ['unique', 'duplicate', 'adapt'] as const;
export const SKIP_REASON_CODES = ['off_topic', 'audience_mismatch', 'format_unfit', 'low_kpi', 'cadence', 'other'] as const;
export type SkipReasonCode = typeof SKIP_REASON_CODES[number];

export const DecisionReason = z.string().trim().min(10).max(300);

export const PlanSkipInput = z.object({
  idea_id:     z.string().uuid(),
  resource_ref: z.string().min(3).max(200),
  reason:      DecisionReason.describe('Чому ця ідея не йде на цей ресурс: сигнал профілю, плейбука або KPI'),
  reason_code: z.enum(SKIP_REASON_CODES).optional(),
});
export type PlanSkip = z.infer<typeof PlanSkipInput>;

export type DecisionKind = Treatment | 'skip';

export interface PlannedDecision {
  ideaId:      string;
  resourceRef: string;
  decision:    DecisionKind;
  reason:      string;
  reasonCode:  string | null;
  /** 0-based index into the submitted slots (null for skips). */
  slotIndex:   number | null;
  decidedBy:   'planner' | 'system';
}

/** A submitted slot as the decision rules see it (after the per-slot checks). */
export interface DecisionSlot {
  resourceRef: string;
  platform:    Platform;
  format:      string;
  ideaId:      string | null;
  series:      string | null;
  treatment:   Treatment;
  fromSlot:    number | null;
  reason:      string | null;
  /** Resolved instant; null when the slot failed its own checks. */
  at:          Date | null;
}

export interface DecisionContext {
  sections:  Map<string, Pick<PlatformSection, 'per_day'>>;
  /** Usable network resources (ref → platform). */
  resources: Map<string, Platform>;
  ideas:     Map<string, IdeaRow>;
  /** Posts already on a resource in this plan (+ reserved slots for the anchor). */
  used:      (ref: string) => number;
  /** (idea → resources) decided earlier outside this planner (repurpose_post, owner). */
  decided?:  Map<string, Set<string>>;
}

export const CADENCE_REASON = (n: number, max: number) => `cadence full: ${n}/${max} posts on this resource today`;

/** Decision rules (a)–(c) of FR-006; (d) — a unique slot's format in the playbook — stays in validateNetworkPlan. */
export function validateDecisions(slots: DecisionSlot[], skips: PlanSkip[], c: DecisionContext): { errors: string[]; decisions: PlannedDecision[] } {
  const errors: string[] = [];
  const decisions: PlannedDecision[] = [];
  const label = (i: number) => `слот ${i + 1} (${slots[i].resourceRef})`;

  slots.forEach((s, i) => {
    if (s.ideaId && !s.reason) errors.push(`${label(i)}: потрібен reason (10–300 символів) — чому це рішення для цього ресурсу`);
    if (s.treatment === 'unique') {
      if (s.fromSlot != null) errors.push(`${label(i)}: from_slot лише для duplicate/adapt`);
      return;
    }
    if (s.fromSlot == null) { errors.push(`${label(i)}: ${s.treatment} потребує from_slot (номер унікального слота-джерела в цьому плані)`); return; }
    const j = s.fromSlot - 1;
    const src = slots[j];
    if (!src || j === i) { errors.push(`${label(i)}: from_slot ${s.fromSlot} — немає такого слота`); return; }
    if (src.treatment !== 'unique') { errors.push(`${label(i)}: джерело (слот ${s.fromSlot}) теж похідне — ланцюжки заборонені, вкажи унікальний слот`); return; }
    if ((src.ideaId ?? null) !== (s.ideaId ?? null) || (!s.ideaId && (src.series ?? null) !== (s.series ?? null))) {
      errors.push(`${label(i)}: джерело (слот ${s.fromSlot}) — інша ідея`);
    }
    if (src.resourceRef === s.resourceRef) errors.push(`${label(i)}: джерело на тому самому ресурсі`);
    if (src.at && s.at && s.at.getTime() < src.at.getTime()) errors.push(`${label(i)}: не раніше за джерело (слот ${s.fromSlot}); інтервал обираєш ти, 0 теж можна`);
    const problem = derivedFormatProblem({ platform: src.platform, format: src.format }, { platform: s.platform, format: s.format }, s.treatment as DerivedTreatment);
    if (problem) errors.push(`${label(i)}: unsupported_format — ${problem}`);
  });

  const inPlan = new Map<string, number[]>();
  slots.forEach((s, i) => { if (s.ideaId) inPlan.set(s.ideaId, [...(inPlan.get(s.ideaId) ?? []), i]); });
  const skipsBy = new Map<string, PlanSkip[]>();
  for (const k of skips) {
    if (!inPlan.has(k.idea_id)) { errors.push(`skip ${k.idea_id} → ${k.resource_ref}: ідеї немає в цьому плані (пропуски — лише для ідей, які плануєш)`); continue; }
    if (!c.resources.has(k.resource_ref) || !c.sections.has(k.resource_ref)) { errors.push(`skip ${k.idea_id} → ${k.resource_ref}: ресурс не в мережі або без секції плейбука`); continue; }
    const key = `${k.idea_id}|${k.resource_ref}`;
    skipsBy.set(key, [...(skipsBy.get(key) ?? []), k]);
  }

  for (const [ideaId, idx] of inPlan) {
    for (const [ref] of c.sections) {
      if (!c.resources.has(ref)) continue;
      const here = idx.filter((i) => slots[i].resourceRef === ref);
      const sk = skipsBy.get(`${ideaId}|${ref}`) ?? [];
      const earlier = c.decided?.get(ideaId)?.has(ref) ?? false;
      const n = here.length + sk.length + (earlier ? 1 : 0);
      if (earlier && n > 1) { errors.push(`ідея ${ideaId}: для ${ref} вже є рішення (repurpose_post / власник) — прибери слот чи skip`); continue; }
      if (n > 1) { errors.push(`ідея ${ideaId}: для ${ref} має бути одне рішення, а є ${n} (слоти й skips разом)`); continue; }
      if (earlier) continue;
      if (n === 0) {
        const max = c.sections.get(ref)!.per_day.max;
        const used = c.used(ref);
        if (used >= max) {
          decisions.push({ ideaId, resourceRef: ref, decision: 'skip', reason: CADENCE_REASON(used, max), reasonCode: 'cadence', slotIndex: null, decidedBy: 'system' });
        } else {
          errors.push(`ідея ${ideaId}: немає рішення для ${ref} — додай слот (unique / duplicate / adapt) або skips з причиною`);
        }
        continue;
      }
      if (here.length) {
        const s = slots[here[0]];
        decisions.push({ ideaId, resourceRef: ref, decision: s.treatment, reason: s.reason ?? '', reasonCode: null, slotIndex: here[0], decidedBy: 'planner' });
      } else {
        decisions.push({ ideaId, resourceRef: ref, decision: 'skip', reason: sk[0].reason, reasonCode: sk[0].reason_code ?? 'other', slotIndex: null, decidedBy: 'planner' });
      }
    }
  }
  return { errors, decisions };
}
