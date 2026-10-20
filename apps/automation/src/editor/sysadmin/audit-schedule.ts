import type { OwnerInbox, InboxItemInput } from '../agents/owner-inbox';
import { isoWeek, kyivDate, kyivHM, kyivWeekday } from '../owner-bot/owner-reports';
import { plural } from '../owner-bot/owner-text';
import type { AuditReport } from './audit-report';
import { reportCounts } from './audit-report';
import type { AuditService } from './audit.service';
import { clip } from './audit-text';

/**
 * Spec 055 FR-004: the weekly audit. A tick a minute asks `auditDue`; a due week is claimed by the unique insert of the
 * scheduled report (`AuditService.run('schedule')`: a second instance, a restart or a manual run in the same week is a clean
 * no-op), and a finished run with open findings posts one note to the owner's inbox (`postOnce`, one per report).
 */

export const DEFAULT_AUDITOR_WEEKDAY = 1;
export const DEFAULT_AUDITOR_AT = '06:30';
export const AUDIT_INBOX_KIND = 'audit_report';
export const AUDIT_INBOX_REF = 'audit';

const OFF = new Set(['false', '0', 'off', 'no']);
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The ISO week to run now, or null: switched off, a bad setting, not the day or not the hour yet. Kyiv time. */
export function auditDue(now: Date, env: (k: string) => string | undefined): string | null {
  if (OFF.has((env('AUDITOR_ENABLED') ?? '').trim().toLowerCase())) return null;
  const day = Number((env('AUDITOR_WEEKDAY') ?? '').trim() || DEFAULT_AUDITOR_WEEKDAY);
  if (!Number.isInteger(day) || day < 1 || day > 7) return null;
  const at = (env('AUDITOR_AT') ?? '').trim() || DEFAULT_AUDITOR_AT;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) return null;
  if (kyivWeekday(now) !== DAYS[day - 1] || kyivHM(now) < at) return null;
  return isoWeek(kyivDate(now));
}

/** The owner's inbox item for a scheduled report: null when nothing is open. English stored text, Ukrainian alert. */
export function auditInboxItem(report: AuditReport): (InboxItemInput & { refType: string; refId: string }) | null {
  const c = reportCounts(report.findings);
  if (c.open === 0) return null;
  const first = (report.summary ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const stored = `${c.open} open ${c.open === 1 ? 'finding' : 'findings'} (${c.error} ${c.error === 1 ? 'error' : 'errors'}), ${c.fixable} fixable in one click`;
  const alert = `${c.open} ${plural(c.open, 'знахідка', 'знахідки', 'знахідок')} (${c.error} ${plural(c.error, 'помилка', 'помилки', 'помилок')}), ${c.fixable} можна виправити одним кліком`;
  return {
    kind: AUDIT_INBOX_KIND, refType: AUDIT_INBOX_REF, refId: report.id,
    severity: c.error > 0 ? 'action' : 'info',
    title: `System audit: ${stored}`,
    body: first ? clip(first, 400) : null,
    alert: { title: `Аудит системи: ${alert}`, body: first ? clip(first, 400) : null },
  };
}

export interface AuditTickDeps {
  svc:    Pick<AuditService, 'run'>;
  inbox:  Pick<OwnerInbox, 'postOnce'>;
  env:    (k: string) => string | undefined;
  now?:   () => Date;
  log?:   (msg: string) => void;
}

export type AuditTickResult =
  | { ran: false; reason: 'not_due' | 'done_this_week' | 'week_taken' | 'already_running' | 'run_failed' }
  | { ran: true; week: string; reportId: string; posted: boolean };

/** One tick. Never throws; a week that was claimed (even by a failed run) is not tried again until the next one. */
export class AuditTick {
  /** The week this process has handled (claimed or found taken): a minute tick does not hit the table again. */
  private handled: string | null = null;

  constructor(private readonly d: AuditTickDeps) {}

  async tick(): Promise<AuditTickResult> {
    const now = (this.d.now ?? (() => new Date()))();
    const week = auditDue(now, this.d.env);
    if (!week) return { ran: false, reason: 'not_due' };
    if (this.handled === week) return { ran: false, reason: 'done_this_week' };
    const r = await this.d.svc.run('schedule');
    if (!r.ok) {
      if (r.error === 'week_taken') { this.handled = week; return { ran: false, reason: 'week_taken' }; }
      if (r.error === 'already_running') return { ran: false, reason: 'already_running' };
      this.handled = week;
      this.d.log?.(`weekly audit failed: ${r.details ?? r.error}`);
      return { ran: false, reason: 'run_failed' };
    }
    this.handled = week;
    const item = r.report.status === 'done' ? auditInboxItem(r.report) : null;
    let posted = false;
    if (item) {
      try { posted = (await this.d.inbox.postOnce(item)) !== null; } catch (err: any) { this.d.log?.(`audit inbox note failed: ${err?.message ?? err}`); }
    }
    return { ran: true, week, reportId: r.report.id, posted };
  }
}
