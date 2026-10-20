import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

// The sysadmin's audit (spec 055). The report itself is read through the artifact registry (type `audit`); these are the
// findings' own endpoints: POST /api/audits/:id/findings/:key/apply and …/dismiss {days?}, POST /api/audits/run.

export type FindingStatus = 'open' | 'applied' | 'dismissed' | 'failed';
export type FindingSeverity = 'info' | 'warn' | 'error';
export type FindingArea = 'skills' | 'memory' | 'rules' | 'tools' | 'prompt';

export type AuditFix =
  | { kind: 'skill_disable';     agent: string; skill: string }
  | { kind: 'skill_inline_off';  agent: string; skill: string }
  | { kind: 'memory_retire';     channel: string; id: number }
  | { kind: 'conflicts_resolve'; agent: string };

export interface AuditFinding {
  key:      string;
  area:     FindingArea;
  check:    string;
  severity: FindingSeverity;
  subject:  { type: string; id: string; label: string; agent?: string; channel?: string };
  title:    string;
  detail:   string;
  evidence: Record<string, unknown>;
  fix?:     AuditFix;
  status:   FindingStatus;
  comment?: string;
  at?:      string;
  result?:  string;
  dismissedUntil?: string;
}

export interface AuditLlm { status: 'ok' | 'off' | 'no_agent' | 'budget' | 'failed'; note: string; runId: string | null; costUsd: number }

export interface AuditCounts { total: number; open: number; error: number; warn: number; info: number; fixable: number }

export interface AuditReport {
  id:         string;
  week:       string;
  trigger:    'schedule' | 'owner';
  status:     'running' | 'done' | 'failed';
  findings:   AuditFinding[];
  summary:    string | null;
  llm:        AuditLlm | null;
  costUsd:    number;
  error:      string | null;
  startedAt:  string;
  finishedAt: string | null;
  counts:     AuditCounts;
}

const path = (id: string, key: string, what: 'apply' | 'dismiss') => `/api/audits/${encodeURIComponent(id)}/findings/${encodeURIComponent(key)}/${what}`;

function useFindingMutation<V extends { id: string; key: string }>(call: (v: V) => Promise<AuditReport & { result?: string | null }>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: call,
    // The panel shows the refusal itself (a toast and the finding's own notice).
    meta: { silentError: true },
    // A refused fix still changes the report (the finding turns failed): refresh either way.
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['artifacts'] }); },
  });
}

export function useApplyFinding() {
  return useFindingMutation((v: { id: string; key: string }) => api<AuditReport & { result?: string | null }>(path(v.id, v.key, 'apply'), { method: 'POST', body: '{}' }));
}

export function useDismissFinding() {
  return useFindingMutation((v: { id: string; key: string; days?: number }) =>
    api<AuditReport>(path(v.id, v.key, 'dismiss'), { method: 'POST', body: JSON.stringify({ days: v.days ?? 30 }) }));
}

export function useRunAudit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<AuditReport>('/api/audits/run', { method: 'POST', body: '{}' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['artifacts'] }); },
  });
}
