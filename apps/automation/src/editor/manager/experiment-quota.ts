/**
 * Spec 025 FR-014: experiment quotas opened by `experiment` directives, as the day-plan validators and the
 * planner prompts see them. Pure: the open quotas come from `SqlExperimentQuotas` (manager/executors).
 */

export interface ExperimentQuota {
  directiveId: string;
  resourceRef: string;
  angle:       string;
  format:      string | null;
  /** Slots still to plan (the directive's `slots` minus slots already planned outside this plan day). */
  remaining:   number;
  /** ISO instant: the quota must be filled by then. */
  deadline:    string;
}

/** A submitted slot as the quota rule reads it. */
export interface QuotaSlot { label: string; resourceRef: string; format: string; directiveId: string | null }

/** The planner prompt block (null when there are no open quotas). */
export function renderExperimentQuotas(quotas: ExperimentQuota[]): string | null {
  if (!quotas.length) return null;
  return [
    '## Експерименти за директивою менеджера (обовʼязково)',
    ...quotas.map((q) => `- directive_id ${q.directiveId} → ${q.resourceRef}: кут «${q.angle}»${q.format ? `, формат ${q.format}` : ''}; ще ${q.remaining} слот(и) до ${q.deadline.slice(0, 10)}.`),
    'У плані — щонайменше 1 слот з цим directive_id на цьому ресурсі (не більше, ніж лишилось), тема й кут — за директивою. Такий слот — експеримент: idea_id чи series для нього не потрібні; у частку експериментів (explore_ratio) він не входить.',
  ].join('\n');
}

/**
 * The quota rule of both validators: a slot's directive_id must name an open quota on its resource (and its
 * format, when the quota fixes one); every open quota with capacity on the plan's resources needs at least one
 * slot, and no more than it has left. Errors are Ukrainian lines naming the directive.
 */
export function experimentQuotaErrors(quotas: ExperimentQuota[], slots: QuotaSlot[], hasCapacity: (resourceRef: string) => boolean): string[] {
  const errors: string[] = [];
  const byId = new Map(quotas.map((q) => [q.directiveId, q]));
  for (const s of slots) {
    if (!s.directiveId) continue;
    const q = byId.get(s.directiveId);
    if (!q) { errors.push(`${s.label}: директива ${s.directiveId} не має відкритої квоти експерименту — прибери directive_id`); continue; }
    if (q.resourceRef !== s.resourceRef) errors.push(`${s.label}: експеримент директиви ${q.directiveId} — на ${q.resourceRef}, не на ${s.resourceRef}`);
    else if (q.format && q.format !== s.format) errors.push(`${s.label}: експеримент директиви ${q.directiveId} — у форматі ${q.format}`);
  }
  for (const q of quotas) {
    const n = slots.filter((s) => s.directiveId === q.directiveId && s.resourceRef === q.resourceRef).length;
    if (n === 0 && hasCapacity(q.resourceRef)) {
      errors.push(`директива ${q.directiveId} (експеримент «${q.angle.slice(0, 80)}»): у плані потрібен щонайменше 1 слот з directive_id "${q.directiveId}" на ${q.resourceRef}${q.format ? ` у форматі ${q.format}` : ''} — ще ${q.remaining} до ${q.deadline.slice(0, 10)}`);
    }
    if (n > q.remaining) errors.push(`директива ${q.directiveId}: слотів експерименту ${n}, а лишилось ${q.remaining}`);
  }
  return errors;
}
