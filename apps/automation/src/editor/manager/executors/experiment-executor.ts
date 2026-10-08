import type { Pool } from 'pg';
import { implementedFormats } from '../../platform/capabilities';
import type { Directive } from '../directives.repository';
import type { ExperimentQuota } from '../experiment-quota';
import { anchorRef, notExecutable } from './playbook-change';
import type { DirectiveExecutor, ExperimentChange, VerifyResult } from './types';

/**
 * The `experiment` executor (spec 025 FR-014). Accepting opens a quota: `slots` slots with `directive_id` on
 * `resource_ref` within `within_days`. The plan validators require ≥ 1 such slot per plan day while it is open.
 * Applied = the first slot is planned; verified = `slots` of them published or shadowed; a quota still open at
 * the deadline → failed (DirectiveExecution.closeQuotas).
 */

export const EXPERIMENT = { angle: { min: 10, max: 300 }, slots: { min: 1, max: 3, default: 1 }, days: { min: 1, max: 7, default: 3 } };
/** After the deadline, planned slots still have this long to be published before the verdict is "not followed". */
export const EXPERIMENT_PUBLISH_GRACE_MS = 24 * 3600_000;

export interface QuotaCounts { planned: number; done: number }

/** editor_slots carrying the hint `directive:<id>` (content slots of the anchor's plans). */
export class SqlExperimentQuotas {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  /**
   * Planned (not skipped / failed) and done (published / shadowed) slots of a directive. With `planDate`, the
   * still-replaceable slots of that day's active plan are left out — the plan being submitted replaces them.
   */
  async counts(directiveId: string, anchorKey: string, planDate?: string | null): Promise<QuotaCounts> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*) FILTER (WHERE s.status NOT IN ('skipped','failed')
                                AND NOT ($3::date IS NOT NULL AND p.plan_date = $3::date AND p.status = 'active' AND s.status IN ('planned','awaiting_approval')))::int AS planned,
              COUNT(*) FILTER (WHERE s.status IN ('published','shadowed'))::int AS done
         FROM editor_slots s JOIN editor_plans p ON p.id = s.plan_id
        WHERE s.channel_key = $1 AND s.kind = 'content' AND s.source_hints ? $2`,
      [anchorKey, `directive:${directiveId}`, planDate ?? null]);
    return { planned: Number(rows[0]?.planned ?? 0), done: Number(rows[0]?.done ?? 0) };
  }

  /** Open quotas on an anchor's plans for `planDate`: accepted/applied experiment directives before their deadline with slots left. */
  async open(anchorKey: string, planDate: string, now: Date): Promise<ExperimentQuota[]> {
    const { rows } = await this.pool.query(
      `SELECT id, change FROM agent_directives
        WHERE kind = 'experiment' AND status IN ('accepted','applied') AND NOT shadow
          AND change->>'op' = 'experiment' AND change->>'channel_key' = $1 AND (change->>'deadline')::timestamptz > $2
        ORDER BY created_at`, [anchorKey, now]);
    const out: ExperimentQuota[] = [];
    for (const r of rows) {
      const c = r.change as ExperimentChange;
      const { planned } = await this.counts(r.id, anchorKey, planDate);
      const remaining = Number(c.slots) - planned;
      if (remaining > 0) out.push({ directiveId: r.id, resourceRef: c.resource_ref, angle: c.angle, format: c.format ?? null, remaining, deadline: c.deadline });
    }
    return out;
  }
}

export interface ExperimentExecutorDeps {
  quotas: Pick<SqlExperimentQuotas, 'counts'>;
  now?:   () => Date;
}

const intIn = (v: unknown, r: { min: number; max: number; default: number }): number | null => {
  const n = v == null ? r.default : Number(v);
  return Number.isInteger(n) && n >= r.min && n <= r.max ? n : null;
};

export function experimentExecutor(d: ExperimentExecutorDeps): DirectiveExecutor<ExperimentChange> {
  const now = () => (d.now ?? (() => new Date()))();
  return {
    kind: 'experiment',
    plan(dir, ctx) {
      const p = (dir.params ?? {}) as Record<string, unknown>;
      const angle = String(p.angle ?? '').trim();
      if (angle.length < EXPERIMENT.angle.min || angle.length > EXPERIMENT.angle.max) return notExecutable(`params.angle — кут експерименту, ${EXPERIMENT.angle.min}–${EXPERIMENT.angle.max} символів`);
      const slots = intIn(p.slots, EXPERIMENT.slots);
      if (slots == null) return notExecutable(`params.slots — ціле ${EXPERIMENT.slots.min}–${EXPERIMENT.slots.max}`);
      const days = intIn(p.within_days, EXPERIMENT.days);
      if (days == null) return notExecutable(`params.within_days — ціле ${EXPERIMENT.days.min}–${EXPERIMENT.days.max}`);
      const anchor = anchorRef(ctx);
      if (!ctx.card || !ctx.net || !anchor) return notExecutable('в оркестратора немає картки каналу — виконати нічого');
      const ref = typeof p.resource_ref === 'string' && p.resource_ref.trim() ? p.resource_ref.trim() : anchor;
      const res = ctx.net.resources.find((r) => r.ref === ref);
      if (!res) return notExecutable(`ресурс ${ref} не в мережі @${ctx.orch.handle} або зараз недоступний (є: ${ctx.net.resources.map((r) => r.ref).join(', ')})`);
      // Only an independent network with a playbook plans its other resources; otherwise only the anchor is planned.
      if (ref !== anchor && !(ctx.net.mode === 'independent' && ctx.playbook)) return notExecutable(`${ref} не планується окремо (мережа не в режимі independent або без плейбука) — експеримент лише на ${anchor}`);
      const format = typeof p.format === 'string' && p.format.trim() ? p.format.trim() : null;
      if (format && !implementedFormats(res.platform).includes(format)) return notExecutable(`формат ${format} недоступний для ${res.platform} (є: ${implementedFormats(res.platform).join(', ')})`);
      const max = ctx.playbook ? ctx.playbook.platforms.find((s) => s.resource_ref === ref)?.per_day.max ?? 0 : ctx.card.postsPerDayMax;
      if (max < 1) return notExecutable(`${ref} не має жодного поста на день (per_day.max ${max}) — немає місця для експерименту`);
      return {
        kind: 'experiment', op: 'experiment', target: 'quota', channel_key: ctx.net.anchorKey, resource_ref: ref, angle, format, slots, within_days: days,
        deadline: new Date(ctx.now.getTime() + days * 86_400_000).toISOString(), structural: false,
        reasons: [`experiment on ${ref}: ${slots} slot(s) within ${days} day(s)${format ? ` in ${format}` : ''}`],
      };
    },
    /** Applied once the first slot is planned; until then the quota is open and the directive stays accepted. */
    async apply(change, dir) {
      const { planned } = await d.quotas.counts(dir.id, change.channel_key);
      return planned > 0 ? { noop: false } : { noop: false, pending: true };
    },
    async verify(dir: Directive): Promise<VerifyResult> {
      const c = dir.change as ExperimentChange | null;
      if (!c || c.op !== 'experiment') return { verified: false, adherence: 'not_followed', detail: { reason: 'no change recorded' } };
      const n = await d.quotas.counts(dir.id, c.channel_key);
      const detail = { slots: c.slots, planned: n.planned, done: n.done, deadline: c.deadline };
      if (n.done >= c.slots) return { verified: true, adherence: 'followed', detail };
      if (now().getTime() > new Date(c.deadline).getTime() + EXPERIMENT_PUBLISH_GRACE_MS) return { verified: false, adherence: 'not_followed', detail };
      return { pending: true, detail };
    },
  };
}
