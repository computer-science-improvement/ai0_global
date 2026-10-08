import type { Agent } from '../../agents/agent.types';
import type { AgentsRepository } from '../../agents/agents.repository';
import type { OwnerInbox } from '../../agents/owner-inbox';
import type { Playbook } from '../../network/playbook';
import { localDate } from '../../roles/time';
import type { Directive, DirectiveKind, DirectivesRepository } from '../directives.repository';
import { describe, resumeChange } from './playbook-executors';
import { revertsIn } from './playbook-change';
import type { Change, DirectiveExecutor, ExecContext, PlanResult } from './types';

export * from './types';
export { frequencyExecutor, formatShiftExecutor, pauseSeriesExecutor, type PlaybookExecutorDeps } from './playbook-executors';
export { executionContextOf } from './context';
export { SqlPlanObserver, type PlanObserver } from './plan-observer';

/** Kinds scheduled by PromoPlanner after an orchestrator run (spec 022); not run here. */
export const PROMO_KINDS: DirectiveKind[] = ['cross_promo', 'repost'];
/**
 * Kinds whose executors come with spec 025 T4/T5 (pause_resource, experiment, strategy, task). Until then an
 * accepted one is marked applied with `verification.kind = 'unverified'` (the pre-025 behaviour, now visible).
 */
export const PENDING_EXECUTOR_KINDS: DirectiveKind[] = ['task', 'experiment', 'strategy', 'pause_resource'];
export const MAX_EXEC_ATTEMPTS = 3;
/** An accepted row untouched this long is (re)tried by the hourly housekeeping. */
export const EXEC_RETRY_IDLE_MS = 50 * 60_000;

export interface DirectiveExecutionDeps {
  repo:      Pick<DirectivesRepository, 'get' | 'acceptedForExecution' | 'setChange' | 'execFailed' | 'markApplied' | 'markFailed'
    | 'awaitingVerification' | 'setVerification' | 'dueSeriesResumes' | 'mergeChange' | 'playbookLocks'>;
  inbox:     Pick<OwnerInbox, 'post'>;
  agents:    Pick<AgentsRepository, 'get'>;
  context:   (orch: Agent) => Promise<ExecContext | null>;
  executors: DirectiveExecutor[];
  log?:      (m: string) => void;
  now?:      () => Date;
}

/**
 * Runs the executors (spec 025 FR-009): dry-run at filing, apply after acceptance (with retries and the
 * `failed` path), hourly verify(), the pause_series resume, and the `directive_lock` check.
 */
export class DirectiveExecution {
  private readonly byKind: Map<DirectiveKind, DirectiveExecutor>;

  constructor(private readonly d: DirectiveExecutionDeps) {
    this.byKind = new Map(d.executors.map((e) => [e.kind, e]));
  }

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  executorFor(kind: DirectiveKind): DirectiveExecutor | null { return this.byKind.get(kind) ?? null; }

  /** FR-004: the plan of a directive about to be filed; null when its kind has no executor. */
  async dryRun(dir: Pick<Directive, 'kind' | 'params' | 'toAgentId'>, orch: Agent): Promise<PlanResult | null> {
    const ex = this.executorFor(dir.kind);
    if (!ex) return null;
    const ctx = await this.d.context(orch);
    if (!ctx) return { error: 'not_executable', details: `немає контексту @${orch.handle}` };
    try { return ex.plan(dir, ctx); } catch (err: any) { return { error: 'not_executable', details: String(err?.message ?? err) }; }
  }

  /** After an orchestrator run: every accepted directive of it (followed advice included), promo kinds aside. Returns the processed rows. */
  async executeAccepted(orch: Agent): Promise<Directive[]> {
    const out: Directive[] = [];
    for (const dir of await this.d.repo.acceptedForExecution({ toAgentId: orch.id, except: PROMO_KINDS })) {
      const r = await this.execute(dir, orch);
      if (r) out.push(r);
    }
    return out;
  }

  /** Hourly: accepted rows untouched for an hour (earlier failures, or a run that never reached afterOrchestration). */
  async retryPending(): Promise<Directive[]> {
    const out: Directive[] = [];
    for (const dir of await this.d.repo.acceptedForExecution({ idleMs: EXEC_RETRY_IDLE_MS, except: PROMO_KINDS })) {
      const orch = await this.d.agents.get(dir.toAgentId);
      const r = orch ? await this.execute(dir, orch) : await this.fail(dir, 'the target orchestrator is gone');
      if (r) out.push(r);
    }
    return out;
  }

  /** Plan (or reuse the stored change), apply, mark applied; on error count the attempt (failed after 3). */
  async execute(dir: Directive, orch: Agent): Promise<Directive | null> {
    const ex = this.executorFor(dir.kind);
    if (!ex) {
      if (dir.kind === 'advice') return this.applied(dir, { verification: { kind: 'self_reported' } });
      if (PENDING_EXECUTOR_KINDS.includes(dir.kind)) return this.applied(dir, { verification: { kind: 'unverified', reason: 'no executor for this kind yet' } });
      return this.fail(dir, `no executor for ${dir.kind}`);
    }
    try {
      let change = dir.change as Change | null;
      if (!change) {
        const ctx = await this.d.context(orch);
        const plan = ctx ? ex.plan(dir, ctx) : { error: 'not_executable' as const, details: 'no context' };
        if ('error' in plan) return this.fail(dir, `${plan.error}: ${plan.details}`);
        change = plan;
        await this.d.repo.setChange(dir.id, change);
      }
      const a = await ex.apply(change, dir);
      return this.applied(dir, { change: { ...change, noop: a.noop, ...(a.playbookId ? { playbook_id: a.playbookId, version: a.version } : {}) } });
    } catch (err: any) {
      return this.fail(dir, String(err?.message ?? err));
    }
  }

  private async applied(dir: Directive, p: { change?: unknown; verification?: unknown }): Promise<Directive | null> {
    return this.d.repo.markApplied(dir.id, p);
  }

  private async fail(dir: Directive, error: string): Promise<Directive | null> {
    const attempts = await this.d.repo.execFailed(dir.id, error);
    this.d.log?.(`directive ${dir.id} (${dir.kind}) attempt ${attempts}: ${error}`);
    if (attempts < MAX_EXEC_ATTEMPTS) return (await this.d.repo.get(dir.id)) ?? null;
    const row = await this.d.repo.markFailed(dir.id, error);
    if (row) {
      const orch = await this.d.agents.get(dir.toAgentId);
      const who = orch ? `@${orch.handle}` : 'orchestrator';
      const binding = dir.binding === 'advice';
      await this.d.inbox.post({
        agentId: dir.toAgentId, kind: 'directive_failed', severity: binding ? 'info' : 'action',
        title: `⚠️ ${binding ? 'Advice' : 'Directive'} for ${who}: ${dir.kind} could not be applied`,
        body: `${dir.body}\n\nThe executor failed ${MAX_EXEC_ATTEMPTS} times: ${error}`,
        alert: {
          title: `⚠️ ${binding ? 'Порада' : 'Директива'} для ${who}: ${dir.kind} не виконана`,
          body: `${dir.body}\n\nВиконавець не зміг ${MAX_EXEC_ATTEMPTS} рази: ${error}`,
        },
        refType: 'directive', refId: dir.id,
      });
    }
    return row;
  }

  /** Hourly: verify() on applied rows without a verdict. Returns how many got one. */
  async verifyApplied(): Promise<number> {
    let n = 0;
    for (const dir of await this.d.repo.awaitingVerification([...this.byKind.keys()])) {
      const ex = this.executorFor(dir.kind)!;
      try {
        const r = await ex.verify(dir);
        if (r.pending) continue;
        await this.d.repo.setVerification(dir.id, { kind: 'observed', adherence: r.adherence, detail: r.detail, checked_at: this.now().toISOString() }, r.verified);
        n++;
      } catch (err: any) {
        this.d.log?.(`directive ${dir.id}: verify failed: ${err?.message ?? err}`);
      }
    }
    return n;
  }

  /** Hourly: pause_series directives whose resume date has come write a version with the series active again. */
  async resumeSeries(): Promise<number> {
    const ex = this.executorFor('pause_series');
    if (!ex) return 0;
    let n = 0;
    for (const dir of await this.d.repo.dueSeriesResumes(localDate(this.now(), 'Europe/Kyiv'))) {
      const back = resumeChange(dir.change as Change);
      if (!back) continue;
      try {
        await ex.apply(back, dir);
        await this.d.repo.mergeChange(dir.id, { resumed_at: this.now().toISOString() });
        n++;
      } catch (err: any) {
        // The series was removed or changed by hand: nothing to resume; stop trying.
        await this.d.repo.mergeChange(dir.id, { resumed_at: this.now().toISOString(), resume_error: String(err?.message ?? err) });
      }
    }
    return n;
  }

  /**
   * `directive_lock`: a playbook body an orchestrator submits must not undo a binding directive's change
   * before its review date. Returns the refusal, or null.
   */
  async lockFor(orchId: string, body: Playbook): Promise<{ error: 'directive_lock'; details: string } | null> {
    for (const dir of await this.d.repo.playbookLocks(orchId, this.now())) {
      const c = dir.change as Change | null;
      if (c && revertsIn(body, c)) {
        return {
          error: 'directive_lock',
          details: `директива ${dir.id} (${dir.kind}: ${describe(c)}) діє до ${dir.reviewAt?.toISOString().slice(0, 10) ?? '—'} — цю зміну не можна скасувати до перевірки ефекту; залиш її як є`,
        };
      }
    }
    return null;
  }
}
