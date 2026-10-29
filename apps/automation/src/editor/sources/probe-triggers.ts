import type { CardSource } from '../card';
import { hostOf } from '../net/host-failures';
import { FEEDISH } from './playbook-feeds';
import type { ProberOpts } from './probe';

/**
 * Spec 076 FR-004 / A30: the background probes that a card save and a series bind start. The probe is a port
 * (`EditorOpsDeps.probe`, `ScheduleServiceDeps.probe`): optional, so a service built without it behaves as before.
 *
 * Spec 076 I18 (lead decision): these probes reuse any stored probe younger than 24 h and are never forced, so the launch's own
 * probe of the same address is not repeated; the owner's button and the 6-hourly job are the forced paths.
 */
export type BackgroundProbe = (url: string, o: Pick<ProberOpts, 'kind' | 'maxAgeMs'>) => Promise<unknown>;

/** A stored probe this young is enough for a save or a bind. */
export const SAVE_PROBE_MAX_AGE_MS = 24 * 3_600_000;

export interface ProbeTarget { url: string; kind: 'rss' | 'url' }

const isHttp = (ref: string): boolean => /^https?:\/\//i.test(ref.trim());

/**
 * The `rss` / `url` sources of a saved card that are new or changed against the card as it was: matched by id, changed when its
 * (kind, ref) differs. Sources with no http address (a bad ref the validator let through) are not probed.
 */
export function changedCardSources(before: readonly CardSource[] | undefined | null, after: readonly CardSource[]): ProbeTarget[] {
  const had = new Map((before ?? []).map((s) => [s.id, `${s.kind}|${s.ref.trim()}`]));
  const out: ProbeTarget[] = [];
  const seen = new Set<string>();
  for (const s of after) {
    if ((s.kind !== 'rss' && s.kind !== 'url') || !isHttp(s.ref)) continue;
    if (had.get(s.id) === `${s.kind}|${s.ref.trim()}`) continue;
    const url = s.ref.trim();
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, kind: s.kind });
  }
  return out;
}

/** The address a feed series reads: its ref when that is an http address, else the card source it names (by id or ref). */
function feedSeriesTarget(ref: unknown, cardSources: readonly CardSource[]): ProbeTarget | null {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  const r = ref.trim();
  if (isHttp(r)) return { url: r, kind: FEEDISH.test(r) ? 'rss' : 'url' };
  const named = cardSources.find((s) => (s.id === r || s.ref.trim() === r) && (s.kind === 'rss' || s.kind === 'url') && isHttp(s.ref));
  return named ? { url: named.ref.trim(), kind: named.kind as 'rss' | 'url' } : null;
}

/** `name → target` of the active feed series of a playbook body. */
function feedSeries(body: unknown, cardSources: readonly CardSource[]): Map<string, ProbeTarget> {
  const out = new Map<string, ProbeTarget>();
  const series = body && typeof body === 'object' ? (body as { series?: unknown }).series : null;
  for (const s of Array.isArray(series) ? series as Array<Record<string, any>> : []) {
    if (!s || typeof s.name !== 'string' || s.source?.kind !== 'feed') continue;
    const t = feedSeriesTarget(s.source.ref, cardSources);
    if (t) out.set(s.name, t);
  }
  return out;
}

/**
 * The feed addresses of the series that are new or changed in `after` against the playbook as it was in `before` (null = none).
 * A series is changed when it is new or reads another address than it did. Several series on one address give one target.
 */
export function changedSeriesFeeds(before: unknown, after: unknown, cardSources: readonly CardSource[]): ProbeTarget[] {
  const had = feedSeries(before, cardSources);
  const out: ProbeTarget[] = [];
  const seen = new Set<string>();
  for (const [name, t] of feedSeries(after, cardSources)) {
    if (had.get(name)?.url === t.url || seen.has(t.url)) continue;
    seen.add(t.url);
    out.push(t);
  }
  return out;
}

/**
 * Starts the probes without waiting for them: the save or the bind answers at once. A probe never throws into the caller, and
 * only an address with a host is asked. Returns nothing; the result is in `source_probes` for the panel.
 */
export function probeInBackground(probe: BackgroundProbe | undefined, targets: readonly ProbeTarget[], log?: (m: string) => void): void {
  if (!probe) return;
  for (const t of targets) {
    if (!hostOf(t.url)) continue;
    const failed = (err: unknown) => log?.(`source probe of ${t.url} failed: ${String((err as Error)?.message ?? err)}`);
    try {
      void Promise.resolve(probe(t.url, { kind: t.kind, maxAgeMs: SAVE_PROBE_MAX_AGE_MS })).catch(failed);
    } catch (err) {
      failed(err);
    }
  }
}
