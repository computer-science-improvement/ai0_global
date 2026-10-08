import type { DirectiveKind, Expected, KpiMetric } from './directives.repository';
import type { KpiDigest } from './kpi-digest.service';

/**
 * Binding levels and the kind × binding matrix (spec 025 FR-002/FR-003). Code only: the model picks a
 * binding, these rules decide whether it may.
 *
 * - `directive`: a command the orchestrator must carry out unless a higher layer (owner rules, safety) forbids it;
 * - `advice`: optional, the orchestrator follows or declines it.
 */
export const BINDINGS = ['directive', 'advice'] as const;
export type Binding = typeof BINDINGS[number];

/** Which binding each kind may have. `frequency` is "either" below |change_pct| 30 and structural above. */
export const KIND_BINDING: Record<DirectiveKind, 'advice' | 'either' | 'directive'> = {
  advice:         'advice',
  task:           'either',
  format_shift:   'either',
  pause_series:   'either',
  experiment:     'either',
  repost:         'either',
  frequency:      'either',
  cross_promo:    'directive',
  pause_resource: 'directive',
  strategy:       'directive',
};

/** Kinds that are always structural (they need the owner, D1). */
export const ALWAYS_STRUCTURAL: ReadonlySet<DirectiveKind> = new Set(['cross_promo', 'pause_resource', 'strategy']);
export const STRUCTURAL_FREQUENCY_PCT = 30;

/**
 * The parameter-level structural rule. The executor dry-run (FR-004) can add to it (a format added, per_day
 * ≥ ±30 % after rounding); it never removes structure.
 */
export function paramStructural(kind: DirectiveKind, params: Record<string, unknown>): boolean {
  if (ALWAYS_STRUCTURAL.has(kind)) return true;
  if (params.add_platform) return true;
  if (kind === 'frequency' && Math.abs(Number(params.change_pct ?? 0)) >= STRUCTURAL_FREQUENCY_PCT) return true;
  return false;
}

export type MatrixError = { error: 'advice_kind_is_advice' | 'structural_must_be_directive'; details: string };

/** FR-002: is this binding allowed for this kind (and its structural-ness)? null = allowed. */
export function checkBinding(kind: DirectiveKind, binding: Binding, structural: boolean): MatrixError | null {
  const rule = KIND_BINDING[kind];
  if (rule === 'advice' && binding !== 'advice') {
    return { error: 'advice_kind_is_advice', details: 'kind advice — завжди порада: подай її з binding "advice"' };
  }
  if (binding === 'advice' && (rule === 'directive' || structural)) {
    return { error: 'structural_must_be_directive', details: `${kind} тут структурна зміна — її можна дати лише як директиву (binding "directive"), рішення за власником` };
  }
  return null;
}

/** The digest rows of a directive's scope: its resource_ref, else every resource of the target orchestrator. */
export function scopeRows(dg: Pick<KpiDigest, 'resources'> | null | undefined, targetHandle: string, resourceRef?: string | null) {
  const rows = dg?.resources ?? [];
  return rows.filter((r) => (resourceRef ? r.ref === resourceRef : r.agent === targetHandle));
}

/** Is `metric` flagged as an anomaly for the scope in the digest? */
export function metricAnomaly(dg: Pick<KpiDigest, 'resources'> | null | undefined, targetHandle: string, metric: KpiMetric, resourceRef?: string | null): boolean {
  return scopeRows(dg, targetHandle, resourceRef).some((r) => r.anomalies?.includes(metric));
}

/** The scope's 7-day value of `metric` (mean over its resources), from the compact digest. */
export function metricValue(dg: Pick<KpiDigest, 'resources'> | null | undefined, targetHandle: string, metric: KpiMetric, resourceRef?: string | null): number | null {
  const vals = scopeRows(dg, targetHandle, resourceRef)
    .map((r) => (r.kpis as Record<string, { v?: number | null } | undefined>)?.[metric]?.v)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

/** Declined advice is an escalation basis for 14 days. */
export const ESCALATION_WINDOW_MS = 14 * 86_400_000;
/** "Moved further against expected": at least this many % since the advice was filed. */
export const ESCALATION_MIN_MOVE_PCT = 5;
/** At most this many open binding directives per orchestrator. */
export const MAX_OPEN_BINDING = 2;

/** A declined advice of the same kind to the same target, with the metric value recorded when it was filed. */
export interface DeclinedAdvice { id: string; expected: Expected | null; filedValue: number | null }

/**
 * Signed move of the metric since the declined advice, in % (negative = further against `expected`).
 * null when there is nothing to compare.
 */
export function moveSince(advice: DeclinedAdvice, expected: Expected, now: number | null): number | null {
  if (!advice.expected || advice.expected.metric !== expected.metric) return null;
  if (advice.filedValue == null || now == null || advice.filedValue === 0) return null;
  const pct = ((now - advice.filedValue) / Math.abs(advice.filedValue)) * 100;
  return expected.direction === 'up' ? pct : -pct;
}

export type AdmissionResult =
  | { ok: true; basis: 'structural' | 'anomaly' | 'escalation' | 'advice' | 'owner' ; detail?: Record<string, unknown> }
  | { error: 'directive_needs_anomaly' | 'binding_limit'; details: string };

/**
 * FR-003: a non-structural binding directive needs an anomaly of `expected.metric` in the target's scope, or an
 * escalation (advice of the same kind declined in the last 14 days and the metric has since moved further
 * against `expected`). At most MAX_OPEN_BINDING open binding directives per target.
 */
export function admitDirective(i: {
  binding: Binding; structural: boolean; ownerApproved: boolean; targetHandle: string; expected: Expected | null;
  digest: Pick<KpiDigest, 'resources'> | null; declined: DeclinedAdvice | null; openBinding: number;
}): AdmissionResult {
  if (i.binding === 'advice') return { ok: true, basis: 'advice' };
  if (i.ownerApproved) return { ok: true, basis: 'owner' };
  if (i.openBinding >= MAX_OPEN_BINDING) {
    return { error: 'binding_limit', details: `у @${i.targetHandle} вже ${i.openBinding} відкриті директиви — не більше ${MAX_OPEN_BINDING}; дай пораду (binding "advice") або дочекайся результату` };
  }
  if (i.structural) return { ok: true, basis: 'structural' };
  const exp = i.expected;
  if (exp && metricAnomaly(i.digest, i.targetHandle, exp.metric, exp.resource_ref)) {
    return { ok: true, basis: 'anomaly', detail: { metric: exp.metric } };
  }
  if (exp && i.declined) {
    const move = moveSince(i.declined, exp, metricValue(i.digest, i.targetHandle, exp.metric, exp.resource_ref));
    if (move != null && move <= -ESCALATION_MIN_MOVE_PCT) {
      return { ok: true, basis: 'escalation', detail: { declined_advice: i.declined.id, move_pct: Math.round(move * 10) / 10 } };
    }
  }
  return {
    error: 'directive_needs_anomaly',
    details: 'директива (обовʼязкова) — лише коли expected.metric позначена anomaly для цього агента в дайджесті, або після відхиленої поради того ж типу, коли метрика пішла ще далі. Інакше подай це як пораду: binding "advice".',
  };
}
