import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import { describeError, toast } from '../components/ui/Toast';
import { sourceErrorMessage } from '../lib/source-probe';
import type { SourceProbe } from './agents';

// Spec 076 FR-004 / FR-005 / FR-008: the four source tools of the Sources panel. "Test from server" reads an address from the
// server, "Upload the page" hands it a page saved in a browser, "Remove" takes a source off the card and "Route via proxy" adds
// its host to the egress proxy list. Each refusal is shown in words (lib/source-probe.ts `sourceErrorMessage`).

const BASE = '/api/editor/sources';

/** The full answer of "Test from server": the row's `SourceProbe` plus what only the dialog shows. */
export interface ProbeResult extends SourceProbe {
  url: string; feed_url: string | null; sample_titles: string[]; ms: number | null; cached: boolean; blocked_until: string | null;
}
export type ProbeKind = 'rss' | 'url';

/** An upload without a dataset: the page is kept (7 days) and the chat's `import_list` takes its id. */
export interface UploadedPage { doc_id: string; url: string; kind: string; title: string | null; sections: number; chars: number }
/** An upload with a dataset: the re-sync it ran. */
export interface ResyncResult { dataset: string; import_id: string | null; inserted: number; updated: number; skipped: number; invalid: number; note?: string }
export const isResync = (r: UploadedPage | ResyncResult): r is ResyncResult => 'dataset' in r;

export interface UploadInput { url: string; content: string; content_type?: 'text/html' | 'text/plain' | 'text/markdown'; dataset?: string }

export interface ProxyHostResult { hosts: string[]; applied: string; probe: ProbeResult | null }
export interface DropResult { ok: boolean; applied?: string }

const failure = (err: unknown): string => (err instanceof ApiError ? sourceErrorMessage(err.status, err.message) : null) ?? describeError(err);

/** The panels show the sources report and the Health page lists the same sources: both read again after a change. */
function refresh(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: ['agents', 'sources'] });
  void qc.invalidateQueries({ queryKey: ['network-health'] });
}

/** "Test from server": a forced read, so the answer is never an older one. */
export function useProbeSource() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (v: { url: string; kind?: ProbeKind }) => api<ProbeResult>(`${BASE}/probe`, { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: (r) => {
      if (r.ok) toast.success(`The server read it: ${r.detail}`);
      else toast.error(`The server could not read it: ${r.detail}`);
      refresh(qc);
    },
    onError: (e) => toast.error(failure(e)),
  });
}

/** "Upload the page": the file or pasted text of a page, under the address it came from; with `dataset` it re-syncs that dataset. */
export function useUploadPage() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (v: UploadInput) => api<UploadedPage | ResyncResult>(`${BASE}/upload`, { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: (r) => {
      refresh(qc);
      if (isResync(r)) void qc.invalidateQueries({ queryKey: ['data'] });
    },
    onError: (e) => toast.error(failure(e)),
  });
}

/** "Remove": the card without that source. */
export function useDropSource() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (v: { channel: string; sourceId: string }) => api<DropResult>(`${BASE}/drop`, { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: (r) => {
      toast.success(r.applied ?? 'Source removed');
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['network-health'] });
    },
    onError: (e) => toast.error(failure(e)),
  });
}

/** "Route via proxy": the host joins the proxy list, then the address is read once more to show whether it helped. */
export function useAddProxyHost() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (v: { host: string; url?: string; kind?: ProbeKind }) => api<ProxyHostResult>(`${BASE}/proxy-host`, { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: (r) => {
      if (!r.probe) toast.success(r.applied);
      else if (r.probe.ok) toast.success(`${r.applied}. The server reads it now: ${r.probe.detail}`);
      else toast.error(`${r.applied}, but the server still cannot read it: ${r.probe.detail}`);
      refresh(qc);
    },
    onError: (e) => toast.error(failure(e)),
  });
}
