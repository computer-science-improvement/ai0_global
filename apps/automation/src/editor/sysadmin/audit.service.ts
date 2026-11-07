import { isoWeek, kyivDate } from '../owner-bot/owner-reports';
import type { Finding } from './audit.types';
import { AuditRepository, reportCounts, type AuditReport, type ReportFinding, type ReportTrigger } from './audit-report';
import type { AuditPass } from './auditor-runner';
import { clip } from './audit-text';
import { errText } from '../../common/err-text';
import { describeFix, fixErrorText, runFix, type AuditFixPorts } from './fix-runner';
import type { Fix } from './audit.types';
import type { AutonomyDecisionsRepository, AutonomyUndo, UndoRecord } from '../autonomy/autonomy-decisions.repository';
import { silenceApplies, type Env } from '../autonomy/owner-gates';

export type { AuditFixPorts } from './fix-runner';

/** Spec 090 FR-006: `applied_by` of a fix code applied because the owner stayed silent. */
export const SILENCE_BY = 'auto:silence';
export const MEMORY_RETIRE_UNDO_KIND = 'memory_retire';
export const SKILL_INLINE_UNDO_KIND = 'skill_inline_off';

/** The channel a fix is about (the decision log filters by it). */
const channelOf = (fix: Fix): string | null => ('channel' in fix && typeof fix.channel === 'string' ? fix.channel : null);

/** Spec 090 FR-010: how to reverse a fix, only where `fix-runner` has an inverse; null otherwise (nothing records the old value). */
export function auditUndoFor(fix: Fix): UndoRecord | null {
  switch (fix.kind) {
    case 'memory_retire':    return { kind: MEMORY_RETIRE_UNDO_KIND, channel: fix.channel, id: fix.id };
    case 'skill_inline_off': return { kind: SKILL_INLINE_UNDO_KIND, agent: fix.agent, skill: fix.skill };
    default:                 return null;
  }
}

/**
 * Spec 055 FR-003: run an audit, store it, and apply or dismiss its findings. The fixes are a closed list; each one is a call
 * to an existing service, and a fix whose subject changed since the report (the skill is gone, the row is already retired)
 * is refused with the reason and the finding is marked `failed`.
 */

export const DISMISS_DAYS_DEFAULT = 30;
export const DISMISS_DAYS_MAX = 365;
const DAY = 86_400_000;

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

  /**
   * Spec 090 FR-006: open findings whose fix kind is safe (`SILENCE_APPLY_AUDIT_FIX_KINDS`) are applied by code once the
   * latest report is older than AUDIT_AUTO_FIX_HOURS (0 = off), through the same `apply` as the owner's click, `by =
   * 'auto:silence'`. A kind the registry does not know waits (as do the `SILENCE_WAIT_AUDIT_FIX_KINDS`); `series_resume`
   * only for `pause_cause_gone`. A fix that fails stays `failed` (it is not tried again) and is logged once as `failed`.
   * Never throws.
   */
  async silenceSweep(o: { env: Env; decisions: Pick<AutonomyDecisionsRepository, 'record'>; now?: Date }): Promise<{ applied: number; failed: number }> {
    const out = { applied: 0, failed: 0 };
    const now = o.now ?? this.now();
    try {
      const report = await this.d.repo.latest();
      if (!report || !report.finishedAt) return out;
      const reportAt = new Date(report.finishedAt);
      for (const f of report.findings) {
        if (f.status !== 'open' || !f.fix) continue;
        const gate = `audit_fix:${f.fix.kind}`;
        let applies = false;
        try { applies = silenceApplies(gate, o.env, reportAt, now); } catch { applies = false; } // a kind the registry lacks waits
        if (!applies) continue;
        if (f.fix.kind === 'series_resume' && f.check !== 'pause_cause_gone') continue;
        const fix = f.fix;
        const r = await this.apply(report.id, f.key, SILENCE_BY);
        if (r.ok) {
          out.applied++;
          await o.decisions.record({
            gate, refType: 'audit_finding', refId: `${report.id}:${f.key}`, channelKey: channelOf(fix), action: 'applied',
            summary: `${describeFix(fix)} (audit finding "${f.title}")`.slice(0, 480), undo: auditUndoFor(fix), at: now,
          });
        } else if (r.error === 'fix_failed') {
          out.failed++;
          await o.decisions.record({
            gate, refType: 'audit_finding', refId: `${report.id}:${f.key}`, channelKey: channelOf(fix), action: 'failed',
            summary: `${describeFix(fix)} failed: ${r.details ?? 'unknown error'}`.slice(0, 480), undo: null, at: now,
          });
        }
      }
    } catch (err) { this.d.log?.(`audit silence sweep failed: ${errText(err)}`); }
    return out;
  }

  /** Spec 090 FR-010: the inverses `fix-runner` has (memory row back on, skill loaded inline again). */
  registerUndo(undo: Pick<AutonomyUndo, 'register'>): void {
    undo.register(MEMORY_RETIRE_UNDO_KIND, async (u) => {
      if (!this.d.fixes.reactivateMemory) throw new Error('reactivating a memory row is not wired');
      if (!(await this.d.fixes.reactivateMemory(String(u.channel ?? ''), Number(u.id)))) throw new Error('the memory row is already active or gone');
    });
    undo.register(SKILL_INLINE_UNDO_KIND, async (u) => {
      await this.d.fixes.patchSkill(String(u.agent ?? ''), String(u.skill ?? ''), { inline: true });
    });
  }

  async apply(reportId: string, key: string, by?: string): Promise<FindingOutcome> {
    const report = await this.d.repo.get(reportId);
    if (!report) return { ok: false, error: 'report_not_found' };
    const f = report.findings.find((x) => x.key === key);
    if (!f) return { ok: false, error: 'finding_not_found', report };
    if (f.status !== 'open' && f.status !== 'failed') return { ok: false, error: 'not_open', details: f.status, report };
    if (!f.fix) return { ok: false, error: 'no_fix', details: 'this finding has no fix: change it by hand', report };

    let result: string;
    try {
      result = (await runFix(this.d.fixes, f.fix)).applied ?? '';
    } catch (err: any) {
      const text = fixErrorText(err);
      const failed = await this.d.repo.updateFinding(reportId, key, (cur) => ({ ...cur, status: 'failed', result: text, at: this.now().toISOString(), ...(by ? { by } : {}) }));
      return { ok: false, error: 'fix_failed', details: text, report: failed ?? report };
    }
    const next = await this.d.repo.updateFinding(reportId, key, (cur) => ({ ...cur, status: 'applied', result, at: this.now().toISOString(), ...(by ? { by } : {}) }));
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
