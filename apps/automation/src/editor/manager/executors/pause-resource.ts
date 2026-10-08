import { localDate, localTimeLabel } from '../../roles/time';
import type { ResourcePauseService } from '../../pauses/resource-pauses';
import { notExecutable } from './playbook-change';
import type { Applied, Change, DirectiveExecutor, VerifyResult } from './types';

/**
 * `pause_resource` (spec 025 FR-013, structural): a resource_pauses row for `days` days. While it is active the
 * guards (networkContext, the scheduler, PromoPlanner, ReservedDispatcher, ApprovalPublisher, the mirrors) keep
 * content and promo off the resource; paid ad slots still publish. It lifts itself at `until`.
 */

export const PAUSE_RESOURCE_DAYS = { min: 1, max: 14, default: 7 };
export const PAUSE_REASON_MIN = 5;
const DAY_MS = 86_400_000;

export interface PauseResourceDeps {
  pauses: Pick<ResourcePauseService, 'pause' | 'byDirective' | 'publishedIn'>;
  now?:   () => Date;
}

const kyiv = (d: Date) => `${localDate(d, 'Europe/Kyiv')} ${localTimeLabel(d, 'Europe/Kyiv')}`;

export function pauseResourceExecutor(d: PauseResourceDeps): DirectiveExecutor {
  const now = () => (d.now ?? (() => new Date()))();
  return {
    kind: 'pause_resource',
    plan(dir, ctx) {
      const p = (dir.params ?? {}) as Record<string, unknown>;
      const ref = typeof p.resource_ref === 'string' ? p.resource_ref.trim() : '';
      if (!ref) return notExecutable('вкажи params.resource_ref — ресурс, який ставимо на паузу');
      if (!ctx.net) return notExecutable('в оркестратора немає картки каналу — виконати нічого');
      if (!ctx.net.resources.some((r) => r.ref === ref)) {
        return notExecutable(`ресурс ${ref} не в мережі @${ctx.orch.handle} або недоступний (є: ${ctx.net.resources.map((r) => r.ref).join(', ') || '—'})`);
      }
      const days = p.days == null ? PAUSE_RESOURCE_DAYS.default : Number(p.days);
      if (!Number.isInteger(days) || days < PAUSE_RESOURCE_DAYS.min || days > PAUSE_RESOURCE_DAYS.max) {
        return notExecutable(`days — ціле число ${PAUSE_RESOURCE_DAYS.min}…${PAUSE_RESOURCE_DAYS.max} (за замовчуванням ${PAUSE_RESOURCE_DAYS.default})`);
      }
      const reason = typeof p.reason === 'string' ? p.reason.trim() : '';
      if (reason.length < PAUSE_REASON_MIN) return notExecutable(`вкажи params.reason (≥ ${PAUSE_REASON_MIN} символів) — чому ресурс ставимо на паузу`);
      const active = ctx.pauses?.find((x) => x.ref === ref);
      if (active) return notExecutable(`${ref} уже на паузі до ${kyiv(active.until)} (Київ)`);
      const until = new Date(ctx.now.getTime() + days * DAY_MS).toISOString();
      return {
        kind: 'pause_resource', target: 'resource', op: 'pause_resource', resource_ref: ref, days, until, reason,
        structural: true, reasons: [`pause ${ref} for ${days} day(s)`],
      };
    },
    async apply(change: Change, dir): Promise<Applied> {
      if (change.op !== 'pause_resource') throw new Error(`pause_resource executor got a ${change.op} change`);
      const until = new Date(change.until);
      if (!(until.getTime() > now().getTime())) throw new Error(`the pause would end at ${change.until}, which has passed`);
      const r = await d.pauses.pause({ resourceRef: change.resource_ref, agentId: dir.toAgentId, directiveId: dir.id, reason: change.reason, until });
      if ('error' in r) throw new Error(`${change.resource_ref} is already paused until ${r.pause.until.toISOString()} by another pause`);
      return { noop: !r.created };
    },
    /**
     * Verified: no content or promo slot on the resource was published or shadowed while the pause was active.
     * Pending until the pause ends (lifted by the owner or at `until`); a violation is reported at once.
     */
    async verify(dir): Promise<VerifyResult> {
      const c = dir.change as Change | null;
      if (!c || c.op !== 'pause_resource') return { verified: false, adherence: 'not_followed', detail: { reason: 'no change recorded' } };
      const p = await d.pauses.byDirective(dir.id);
      if (!p) return { verified: false, adherence: 'not_followed', detail: { reason: 'no pause row' } };
      const t = now();
      const end = p.liftedAt ?? (p.until.getTime() <= t.getTime() ? p.until : null);
      const n = await d.pauses.publishedIn(p.resourceRef, p.startsAt, end ?? t);
      const detail = {
        resource_ref: p.resourceRef, from: p.startsAt.toISOString(), to: (end ?? t).toISOString(), published_or_shadowed: n,
        lifted_by: p.liftedBy, ...(end ? {} : { until: p.until.toISOString() }),
      };
      if (n > 0) return { verified: false, adherence: 'violated', detail };
      if (!end) return { pending: true, detail };
      return { verified: true, adherence: 'followed', detail };
    },
  };
}
