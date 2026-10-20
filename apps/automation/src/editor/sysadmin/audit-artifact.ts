import type { ArtifactAdapter } from '../artifacts/artifact-adapters';
import type { ArtifactAction, ArtifactRow } from '../artifacts/artifact.types';
import type { AuditReport, ReportSummaryRow } from './audit-report';
import { reportCounts } from './audit-report';

/**
 * Spec 055 FR-003: the audit report as a 048 artifact (type `audit`): listed on /app/artifacts, opened in the chat's side
 * panel. Not versioned: a report is its own version, and its findings keep their own status.
 */

export const auditTitle = (r: Pick<AuditReport, 'week' | 'trigger'>) => `Audit · ${r.week}${r.trigger === 'owner' ? ' (on request)' : ''}`;

export function auditSummary(r: Pick<AuditReport, 'status' | 'error' | 'summary'> & { counts: ReturnType<typeof reportCounts> }): string {
  if (r.status === 'running') return 'running';
  if (r.status === 'failed') return `failed${r.error ? ` — ${r.error}` : ''}`;
  const c = r.counts;
  if (!c.total) return 'nothing to report';
  const parts = [c.error ? `${c.error} error${c.error === 1 ? '' : 's'}` : '', c.warn ? `${c.warn} warning${c.warn === 1 ? '' : 's'}` : '', c.info ? `${c.info} info` : ''].filter(Boolean);
  const left = c.open ? `${parts.join(' · ') || 'all handled'}${c.fixable ? ` · ${c.fixable} fixable` : ''}` : 'all handled';
  return left;
}

export function auditActions(status: string): ArtifactAction[] {
  return status === 'running' ? [] : [{ key: 'run', label: 'Run again', method: 'POST', path: '/api/audits/run' }];
}

export function auditAdapter(d: {
  list(limit: number): Promise<ReportSummaryRow[]>;
  get(id: string): Promise<AuditReport | null>;
}): ArtifactAdapter {
  const row = (r: Pick<AuditReport, 'id' | 'week' | 'trigger' | 'status' | 'error' | 'summary' | 'startedAt' | 'finishedAt'> & { counts: ReturnType<typeof reportCounts> }): ArtifactRow => ({
    type: 'audit', id: r.id, title: auditTitle(r), agent: 'sysadmin', channel: null, target: null, status: r.status, version: null,
    updatedAt: new Date(r.finishedAt ?? r.startedAt).toISOString(), summary: auditSummary(r), live: false,
  });
  return {
    type: 'audit',
    async list(f) {
      // An audit belongs to the network, not to a channel or an orchestrator.
      if (f.channel || f.ref || f.agentId) return [];
      const rows = (await d.list(f.limit)).map(row);
      return f.status ? rows.filter((r) => r.status === f.status) : rows;
    },
    async get(id) {
      const r = await d.get(id);
      if (!r) return null;
      return { row: row({ ...r, counts: reportCounts(r.findings) }), body: { ...r, counts: reportCounts(r.findings) } };
    },
    versions: async () => [],
    version: async () => undefined,
    actions: (r) => auditActions(r.status),
  };
}
