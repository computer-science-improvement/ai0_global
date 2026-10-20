import type { Pool } from 'pg';
import type { AuditSeverity, Finding } from './audit.types';
import type { AuditLlmNote } from './auditor-runner';

/**
 * Spec 055 FR-003: the stored report. A report is its own version: `findings` carries every finding with its status, so
 * applying or dismissing one rewrites that entry and nothing else.
 */

export const FINDING_STATUSES = ['open', 'applied', 'dismissed', 'failed'] as const;
export type FindingStatus = typeof FINDING_STATUSES[number];

export interface ReportFinding extends Finding {
  status:          FindingStatus;
  /** The model's comment (clipped to 400 characters). */
  comment?:        string;
  /** When the status last changed (ISO). */
  at?:             string;
  /** What the fix did, or why it failed. */
  result?:         string;
  dismissedUntil?: string;
}

export type ReportStatus = 'running' | 'done' | 'failed';
export type ReportTrigger = 'schedule' | 'owner';

export interface AuditReport {
  id:         string;
  week:       string;
  trigger:    ReportTrigger;
  status:     ReportStatus;
  findings:   ReportFinding[];
  summary:    string | null;
  llm:        AuditLlmNote | null;
  costUsd:    number;
  error:      string | null;
  startedAt:  Date;
  finishedAt: Date | null;
}

export interface FindingCounts { total: number; open: number; error: number; warn: number; info: number; fixable: number }

/** Counts of the findings still open (applied and dismissed ones are history). */
export function reportCounts(findings: ReportFinding[]): FindingCounts {
  const out: FindingCounts = { total: findings.length, open: 0, error: 0, warn: 0, info: 0, fixable: 0 };
  for (const f of findings) {
    if (f.status !== 'open' && f.status !== 'failed') continue;
    out.open++;
    out[f.severity as AuditSeverity]++;
    if (f.fix) out.fixable++;
  }
  return out;
}

const COLUMNS = `id, week, trigger, status, findings, summary, llm, cost_usd, error, started_at, finished_at`;

function rowToReport(r: any): AuditReport {
  return {
    id: r.id, week: r.week, trigger: r.trigger, status: r.status, findings: r.findings ?? [], summary: r.summary, llm: r.llm,
    costUsd: Number(r.cost_usd ?? 0), error: r.error, startedAt: r.started_at, finishedAt: r.finished_at,
  };
}

export interface ReportSummaryRow extends Omit<AuditReport, 'findings'> { counts: FindingCounts }

/** A run left `running` longer than this is dead (a restart in the middle): it no longer blocks a new one. */
export const STALE_RUN_MS = 30 * 60_000;

export class AuditRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Start a report. A scheduled one is the week's claim (null when the week is taken); an owner one is refused (null) while
   * another run is alive. Dead runs are closed as failed first.
   */
  async start(week: string, trigger: ReportTrigger, now: Date = new Date()): Promise<AuditReport | null> {
    await this.pool.query(
      `UPDATE audit_reports SET status = 'failed', error = 'interrupted', finished_at = $1 WHERE status = 'running' AND started_at < $2`,
      [now, new Date(now.getTime() - STALE_RUN_MS)]);
    if (await this.running()) return null;
    const { rows } = await this.pool.query(
      `INSERT INTO audit_reports (week, trigger, started_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING ${COLUMNS}`,
      [week, trigger, now]);
    return rows[0] ? rowToReport(rows[0]) : null;
  }

  async running(): Promise<AuditReport | null> {
    const { rows } = await this.pool.query(`SELECT ${COLUMNS} FROM audit_reports WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`);
    return rows[0] ? rowToReport(rows[0]) : null;
  }

  async finish(id: string, o: { findings: ReportFinding[]; summary: string | null; llm: AuditLlmNote | null; costUsd: number }, now: Date = new Date()): Promise<AuditReport | null> {
    const { rows } = await this.pool.query(
      `UPDATE audit_reports SET status = 'done', findings = $2, summary = $3, llm = $4, cost_usd = $5, finished_at = $6
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, JSON.stringify(o.findings), o.summary, o.llm ? JSON.stringify(o.llm) : null, o.costUsd, now]);
    return rows[0] ? rowToReport(rows[0]) : null;
  }

  async fail(id: string, error: string, now: Date = new Date()): Promise<void> {
    await this.pool.query(`UPDATE audit_reports SET status = 'failed', error = $2, finished_at = $3 WHERE id = $1`, [id, error.slice(0, 500), now]);
  }

  /** A scheduled run that never got to start (nothing to keep): give the week back so the next tick can try again. */
  async release(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM audit_reports WHERE id = $1 AND status = 'running'`, [id]);
  }

  async get(id: string): Promise<AuditReport | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { rows } = await this.pool.query(`SELECT ${COLUMNS} FROM audit_reports WHERE id = $1`, [id]);
    return rows[0] ? rowToReport(rows[0]) : null;
  }

  async latest(): Promise<AuditReport | null> {
    const { rows } = await this.pool.query(`SELECT ${COLUMNS} FROM audit_reports WHERE status = 'done' ORDER BY started_at DESC LIMIT 1`);
    return rows[0] ? rowToReport(rows[0]) : null;
  }

  /** The report before `id` (finished ones), for "what is new since last week". */
  async previous(id: string): Promise<AuditReport | null> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM audit_reports WHERE status = 'done' AND id <> $1 AND started_at < (SELECT started_at FROM audit_reports WHERE id = $1)
        ORDER BY started_at DESC LIMIT 1`, [id]);
    return rows[0] ? rowToReport(rows[0]) : null;
  }

  async list(limit = 30): Promise<ReportSummaryRow[]> {
    const { rows } = await this.pool.query(`SELECT ${COLUMNS} FROM audit_reports ORDER BY started_at DESC LIMIT $1`, [Math.min(Math.max(limit, 1), 100)]);
    return rows.map((r) => {
      const { findings, ...rest } = rowToReport(r);
      return { ...rest, counts: reportCounts(findings) };
    });
  }

  /**
   * Change one finding of a report under a row lock, so two clicks never overwrite each other. `change` gets the current
   * entry and returns the next one (or null to leave it); the new report comes back.
   */
  async updateFinding(id: string, key: string, change: (f: ReportFinding) => ReportFinding | null): Promise<AuditReport | null> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const { rows } = await c.query(`SELECT ${COLUMNS} FROM audit_reports WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows[0]) { await c.query('ROLLBACK'); return null; }
      const report = rowToReport(rows[0]);
      const i = report.findings.findIndex((f) => f.key === key);
      const next = i >= 0 ? change(report.findings[i]) : null;
      if (i < 0 || !next) { await c.query('ROLLBACK'); return report; }
      report.findings[i] = next;
      await c.query(`UPDATE audit_reports SET findings = $2 WHERE id = $1`, [id, JSON.stringify(report.findings)]);
      await c.query('COMMIT');
      return report;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  // ── dismissals ────────────────────────────────────────────────────────────

  async dismiss(key: string, until: Date, by = 'owner'): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_dismissals (finding_key, until, by, at) VALUES ($1, $2, $3, now())
       ON CONFLICT (finding_key) DO UPDATE SET until = EXCLUDED.until, by = EXCLUDED.by, at = now()`, [key, until, by]);
  }

  /** The keys dismissed and not yet back (until in the future). */
  async dismissedKeys(now: Date = new Date()): Promise<Set<string>> {
    const { rows } = await this.pool.query(`SELECT finding_key FROM audit_dismissals WHERE until > $1`, [now]);
    return new Set(rows.map((r) => r.finding_key as string));
  }
}
