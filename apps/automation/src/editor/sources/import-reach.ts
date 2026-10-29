import type { StoredDoc } from '../docs/doc-types';
import { PROBE_CACHE_HOURS, type ProbeFailureClass, type ProbeResult } from './probe';

/**
 * Spec 076 A16: whether the server can read an import's page again, shown in the `import_list` preview. The weekly re-sync
 * fetches the page from the server, so a page the server cannot read (or one the owner uploaded) will be re-synced by hand.
 */
export interface ImportReach {
  ok:            boolean;
  /** `auto`: the weekly job can re-read it; `manual`: the owner uploads the page again. */
  resync:        'auto' | 'manual';
  detail:        string;
  failure_class?: ProbeFailureClass | null;
  checked_at?:   string;
  via_proxy?:    boolean;
}

export const REACH_MANUAL_LINE = 'The server cannot re-read this page: re-sync of this dataset is manual (upload the page again).';

/** The probe of a page, cache first (what `sourceProberOf` is). */
export type ReachProbe = (url: string, o: { kind: 'url' }) => Promise<ProbeResult>;

/**
 * - a JSON document: no `reach` (JSON APIs stay on spec 066);
 * - an uploaded document: manual, no probe;
 * - a document fetched live within `PROBE_CACHE_HOURS`: the server just read it, no probe;
 * - otherwise the address is probed (cache first); a failed probe is manual.
 * Null when there is nothing to say, including when the probe itself cannot run.
 */
export async function importReach(
  doc: Pick<StoredDoc, 'kind' | 'origin' | 'fetched_at'>, url: string, probe: ReachProbe | undefined, now: Date = new Date(),
): Promise<{ reach: ImportReach; line: string | null } | null> {
  if (!probe || doc.kind === 'json') return null;
  if (doc.origin === 'upload') return { reach: { ok: false, resync: 'manual', detail: 'uploaded page' }, line: REACH_MANUAL_LINE };
  if (now.getTime() - doc.fetched_at <= PROBE_CACHE_HOURS * 3_600_000) return { reach: { ok: true, resync: 'auto', detail: 'read just now' }, line: null };
  let r: ProbeResult;
  try {
    r = await probe(url, { kind: 'url' });
  } catch {
    return null;
  }
  const reach: ImportReach = {
    ok: r.ok, resync: r.ok ? 'auto' : 'manual', detail: r.detail, ...(r.failure_class ? { failure_class: r.failure_class } : {}),
    checked_at: r.checked_at, ...(r.via_proxy ? { via_proxy: true } : {}),
  };
  return { reach, line: r.ok ? null : REACH_MANUAL_LINE };
}
