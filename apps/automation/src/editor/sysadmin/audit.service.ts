import type { Agent } from '../agents/agent.types';
import { isoWeek, kyivDate } from '../owner-bot/owner-reports';
import type { Fix, Finding } from './audit.types';
import { AuditRepository, reportCounts, type AuditReport, type ReportFinding, type ReportTrigger } from './audit-report';
import type { AuditPass } from './auditor-runner';
import { clip } from './audit-text';
import { errText } from '../../common/err-text';

/**
 * Spec 055 FR-003: run an audit, store it, and apply or dismiss its findings. The fixes are a closed list; each one is a call
 * to an existing service, and a fix whose subject changed since the report (the skill is gone, the row is already retired)
 * is refused with the reason and the finding is marked `failed`.
 */

export const DISMISS_DAYS_DEFAULT = 30;
export const DISMISS_DAYS_MAX = 365;
const DAY = 86_400_000;

/** The existing services the fixes call, narrowed to what they need. */
export interface AuditFixPorts {
  agentByHandle(handle: string): Promise<Agent | null>;
  /** AgentsService.patchSkill: throws a Nest exception when the agent or the skill is gone. */
  patchSkill(handle: string, name: string, patch: { enabled?: boolean; inline?: boolean }): Promise<unknown>;
  /** Retires a reviewer row (never an owner row); false when nothing was retired. */
  retireMemory(channel: string, id: number): Promise<boolean>;
  /** ConfigConflictsService.apply. */
  applyConflicts(orch: Agent): Promise<{ applied: string[]; remaining: unknown[] }>;
}

export interface AuditServiceDeps {
  repo:   AuditRepository;
  /** AuditorRunner.run. */
  pass:   () => Promise<AuditPass>;
  fixes:  AuditFixPorts;
  now?:   () => Date;
  log?:   (msg: string) => void;
}

export type RunOutcome =
  | { ok: true; report: AuditReport }
  | { ok: false; error: 'already_running' | 'week_taken' | 'run_failed'; details?: string };

export type FindingOutcome =
  | { ok: true; report: AuditReport; result?: string }
  | { ok: false; error: 'report_not_found' | 'finding_not_found' | 'not_open' | 'no_fix' | 'fix_failed'; details?: string; report?: AuditReport };

/** "<n> skills …" — what a fix did, in one line. */
function describe(fix: Fix, extra?: string): string {
  switch (fix.kind) {
    case 'skill_disable':     return `Skill ${fix.skill} switched off for @${fix.agent}`;
    case 'skill_inline_off':  return `Skill ${fix.skill} is no longer loaded inline for @${fix.agent}`;
    case 'memory_retire':     return `Memory row #${fix.id} of ${fix.channel} retired`;
    case 'conflicts_resolve': return `Config conflicts of @${fix.agent} resolved${extra ? ` (${extra})` : ''}`;
  }
}

export class AuditService {
  constructor(private readonly d: AuditServiceDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  /** The ISO week (Kyiv) a scheduled run claims. */
  week(at: Date = this.now()): string { return isoWeek(kyivDate(at)); }

  /** Claim the report row: the weekly claim for a scheduled run, a refusal while another run is alive for any. */
  async begin(trigger: ReportTrigger): Promise<{ ok: true; row: AuditReport } | { ok: false; error: 'already_running' | 'week_taken' }> {
    const now = this.now();
    const row = await this.d.repo.start(this.week(now), trigger, now);
    if (row) return { ok: true, row };
    return { ok: false, error: (await this.d.repo.running()) ? 'already_running' : 'week_taken' };
  }

  /**
   * Fill a claimed report: load and check, ask the model, drop the dismissed keys, store. The checks failing fails the
   * report; the model failing never does. Never throws.
   */
  async execute(row: AuditReport): Promise<RunOutcome> {
    try {
      const pass = await this.d.pass();
      const dismissed = await this.d.repo.dismissedKeys(this.now());
      const findings: ReportFinding[] = pass.findings.filter((f) => !dismissed.has(f.key)).map((f) => ({
        ...f, status: 'open' as const, ...(pass.comments[f.key] ? { comment: pass.comments[f.key] } : {}),
      }));
      const report = await this.d.repo.finish(row.id, { findings, summary: pass.summary, llm: pass.llm, costUsd: pass.llm.costUsd }, this.now());
      return report ? { ok: true, report } : { ok: false, error: 'run_failed', details: 'the report row is gone' };
    } catch (err: any) {
      const details = clip(errText(err), 300);
      this.d.log?.(`audit run failed: ${details}`);
      await this.d.repo.fail(row.id, details, this.now()).catch(() => undefined);
      return { ok: false, error: 'run_failed', details };
    }
  }

  /** begin + execute: the weekly tick and the tests. */
  async run(trigger: ReportTrigger): Promise<RunOutcome> {
    const b = await this.begin(trigger);
    return b.ok ? this.execute(b.row) : b;
  }

  /** The owner's Run: answers at once with the running report; the pass goes on in the background (the page polls). */
  async runInBackground(trigger: ReportTrigger = 'owner'): Promise<RunOutcome> {
    const b = await this.begin(trigger);
    if (!b.ok) return b;
    void this.execute(b.row);
    return { ok: true, report: b.row };
  }

  async apply(reportId: string, key: string): Promise<FindingOutcome> {
    const report = await this.d.repo.get(reportId);
    if (!report) return { ok: false, error: 'report_not_found' };
    const f = report.findings.find((x) => x.key === key);
    if (!f) return { ok: false, error: 'finding_not_found', report };
    if (f.status !== 'open' && f.status !== 'failed') return { ok: false, error: 'not_open', details: f.status, report };
    if (!f.fix) return { ok: false, error: 'no_fix', details: 'this finding has no fix: change it by hand', report };

    let result: string;
    try {
      result = await this.runFix(f.fix);
    } catch (err: any) {
      const msg = clip(String(err?.response?.error ?? errText(err)), 200);
      const detail = err?.response?.details ? `: ${clip(String(err.response.details), 150)}` : '';
      const failed = await this.d.repo.updateFinding(reportId, key, (cur) => ({ ...cur, status: 'failed', result: `${msg}${detail}`, at: this.now().toISOString() }));
      return { ok: false, error: 'fix_failed', details: `${msg}${detail}`, report: failed ?? report };
    }
    const next = await this.d.repo.updateFinding(reportId, key, (cur) => ({ ...cur, status: 'applied', result, at: this.now().toISOString() }));
    return { ok: true, report: next ?? report, result };
  }

  async dismiss(reportId: string, key: string, days: number = DISMISS_DAYS_DEFAULT): Promise<FindingOutcome> {
    const report = await this.d.repo.get(reportId);
    if (!report) return { ok: false, error: 'report_not_found' };
    const f = report.findings.find((x) => x.key === key);
    if (!f) return { ok: false, error: 'finding_not_found', report };
    if (f.status === 'applied' || f.status === 'dismissed') return { ok: false, error: 'not_open', details: f.status, report };
    const d = Math.min(Math.max(Math.round(days) || DISMISS_DAYS_DEFAULT, 1), DISMISS_DAYS_MAX);
    const until = new Date(this.now().getTime() + d * DAY);
    await this.d.repo.dismiss(key, until);
    const next = await this.d.repo.updateFinding(reportId, key, (cur) => ({
      ...cur, status: 'dismissed', dismissedUntil: until.toISOString(), at: this.now().toISOString(), result: `Dismissed for ${d} days`,
    }));
    return { ok: true, report: next ?? report };
  }

  /** Each fix is one call to the service that owns the change; anything that does not apply throws with the reason. */
  private async runFix(fix: Fix): Promise<string> {
    const p = this.d.fixes;
    switch (fix.kind) {
      case 'skill_disable':
        await p.patchSkill(fix.agent, fix.skill, { enabled: false });
        return describe(fix);
      case 'skill_inline_off':
        await p.patchSkill(fix.agent, fix.skill, { inline: false });
        return describe(fix);
      case 'memory_retire': {
        if (!(await p.retireMemory(fix.channel, fix.id))) throw Object.assign(new Error('nothing_to_retire'), { response: { error: 'nothing_to_retire', details: 'the row is already inactive or is not a reviewer row' } });
        return describe(fix);
      }
      case 'conflicts_resolve': {
        const orch = await p.agentByHandle(fix.agent);
        if (!orch) throw Object.assign(new Error('agent_not_found'), { response: { error: 'agent_not_found', details: `@${fix.agent}` } });
        const r = await p.applyConflicts(orch);
        if (!r.applied.length) throw Object.assign(new Error('nothing_to_apply'), { response: { error: 'nothing_to_apply', details: 'the conflicts are already resolved or need a manual change' } });
        return describe(fix, `${r.applied.length} applied, ${r.remaining.length} left`);
      }
    }
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  get(id: string) { return this.d.repo.get(id); }
  list(limit?: number) { return this.d.repo.list(limit); }
  latest() { return this.d.repo.latest(); }
  running() { return this.d.repo.running(); }

  /**
   * What changed since the report before: open findings whose keys the previous report did not have (the owner note and the
   * digest line talk about new problems, not the same ones every week).
   */
  async delta(report: AuditReport): Promise<{ counts: ReturnType<typeof reportCounts>; added: ReportFinding[] }> {
    const prev = await this.d.repo.previous(report.id);
    const seen = new Set((prev?.findings ?? []).map((f: Finding) => f.key));
    const open = report.findings.filter((f) => f.status === 'open');
    return { counts: reportCounts(report.findings), added: prev ? open.filter((f) => !seen.has(f.key)) : open };
  }
}
