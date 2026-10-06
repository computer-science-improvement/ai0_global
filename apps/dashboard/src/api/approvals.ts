import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { TgMessage } from './types';

// Approval mode (spec 031): posts the agents wrote that wait for the owner.
// GET /api/editor/approvals, POST /api/editor/approvals/:id/{approve,edit,reschedule,reject}, POST …/bulk.

export type ApprovalStatus = 'awaiting_approval' | 'approved' | 'expired';
export type ApprovalPlatform = 'telegram' | 'instagram' | 'facebook' | 'threads' | 'tiktok' | 'youtube';

export interface RenderedPlatformPost {
  caption: string; imageUrls: string[]; videoUrl: string | null; carousel: boolean; title: string; firstComment: string | null; link: string | null;
}

export type ApprovalRender =
  | { kind: 'telegram'; messages: TgMessage[]; primary: number }
  | { kind: 'platform'; platform: string; rendered: RenderedPlatformPost };

export interface ApprovalCardData {
  id:            string;
  channelKey:    string;
  channelTitle:  string | null;
  resourceRef:   string;
  platform:      ApprovalPlatform;
  status:        ApprovalStatus | string;
  scheduledAt:   string;
  timezone:      string;
  localDate:     string;
  localTime:     string;
  planDate:      string;
  format:        string;
  topic:         string;
  isExperiment:  boolean;
  spec:          Record<string, any> | null;
  preview:       string | null;
  render:        ApprovalRender | null;
  lintWarnings:  string[];
  ownerEdited:   boolean;
  approvedAt:    string | null;
  expiresAt:     string;
  editableUntil: string;
  replacesSlotId: string | null;
  error:         string | null;
  rationale: {
    idea:   { id: string; title: string; angle: string | null; why: string | null } | null;
    source: { url: string; label: string | null } | null;
    angle:  string | null;
    plan:   string | null;
  };
}

export interface ApprovalFilter {
  channel?:  string;
  resource?: string;
  status?:   ApprovalStatus[];
}

const KEY = ['approvals'] as const;

export function useApprovals(f: ApprovalFilter = {}, opts: { enabled?: boolean } = {}) {
  const qs = new URLSearchParams();
  if (f.channel)  qs.set('channel', f.channel);
  if (f.resource) qs.set('resource', f.resource);
  if (f.status?.length) qs.set('status', f.status.join(','));
  return useQuery({
    queryKey: [...KEY, 'list', f.channel ?? null, f.resource ?? null, (f.status ?? []).join(',')],
    queryFn:  () => api<{ items: ApprovalCardData[]; waiting: number }>(`/api/editor/approvals?${qs.toString()}`),
    refetchInterval: 30_000,
    enabled: opts.enabled ?? true,
  });
}

/** Posts waiting for approval (the menu badge). */
export function useApprovalsCount() {
  return useQuery({
    queryKey: [...KEY, 'count'],
    queryFn:  () => api<{ waiting: number }>('/api/editor/approvals/count'),
    refetchInterval: 60_000,
  });
}

export type ApprovalAction =
  | { id: string; action: 'approve' }
  | { id: string; action: 'edit'; spec: unknown }
  | { id: string; action: 'reschedule'; at: string }
  | { id: string; action: 'reject'; reason?: string };

export interface ApprovalActionResult {
  card: ApprovalCardData;
  movedTo?: string | null;
  warnings?: string[];
  replacementId?: string | null;
}

/** One decision on a post. Callers show errors (409 already_decided, lint) themselves. */
export function useApprovalAction() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (a: ApprovalAction) => {
      const body = a.action === 'edit' ? { spec: a.spec } : a.action === 'reschedule' ? { at: a.at } : a.action === 'reject' ? (a.reason ? { reason: a.reason } : {}) : undefined;
      return api<ApprovalActionResult>(`/api/editor/approvals/${a.id}/${a.action}`, {
        method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}),
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useBulkApprove() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (b: { channel?: string; resource?: string; date?: string; idea_id?: string }) =>
      api<{ approved: number; skippedWithWarnings: number; conflicts: number; ids: string[] }>('/api/editor/approvals/bulk', {
        method: 'POST', body: JSON.stringify(b),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

// ── wall clock of the resource's zone ────────────────────────────────────────

function zoneParts(d: Date, tz: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

/** "YYYY-MM-DDTHH:MM" (datetime-local) of an instant in `tz`. */
export function toZonedInput(d: Date, tz: string): string {
  const p = zoneParts(d, tz);
  const z = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
}

/** A datetime-local value read as wall clock in `tz` → ISO instant (DST-safe, two passes). */
export function zonedInputToIso(v: string, tz: string): string {
  const [date, time] = v.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offset = (t: number) => {
    const p = zoneParts(new Date(t), tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
  };
  let t = guess - offset(guess);
  t = guess - offset(t);
  return new Date(t).toISOString();
}

/** "чт, 9 жовт." of a local date string. */
export function fmtDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('uk-UA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}
