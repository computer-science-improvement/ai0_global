import type { CardSource } from '../card';
import { feedKey, hostOf } from '../net/host-failures';

/**
 * Spec 061 FR-004: the feeds an orchestrator's playbook reads that the channel card does not list. @ai0_global's card has
 * no sources at all: its feeds are the addresses its series name (`source: { kind: 'feed', ref: <url> }`) and the sites its
 * rules point to. Source health used to look at the card only, so it said `sources: []` while marktechpost.com was
 * probed 109 times in 14 days.
 */
export const PLAYBOOK_SOURCE_PREFIX = 'playbook:';

const URL_RE = /https?:\/\/[^\s)"'<>\]]+/gi;
export const FEEDISH = /(^|[/._-])(rss|atom|feed|feeds)([/._?-]|$)|\.xml(\?|$)/i;

const trimUrl = (u: string): string => u.replace(/[.,;:!?»]+$/, '');

/** Page / feed sources a playbook body names, minus those the card already reads (same host or feed address). */
export function playbookSources(body: unknown, cardSources: CardSource[] = []): CardSource[] {
  const pb = body && typeof body === 'object' ? body as { series?: unknown; rules?: unknown } : {};
  const urls: string[] = [];
  for (const s of Array.isArray(pb.series) ? pb.series as Array<Record<string, any>> : []) {
    if (s?.active === false) continue;
    const src = s?.source;
    if (src && src.kind === 'feed' && typeof src.ref === 'string' && /^https?:\/\//i.test(src.ref)) urls.push(src.ref);
  }
  for (const r of Array.isArray(pb.rules) ? pb.rules : []) {
    if (typeof r === 'string') urls.push(...(r.match(URL_RE) ?? []).map(trimUrl));
  }
  const cardHosts = new Set(cardSources.map((c) => hostOf(c.ref)).filter(Boolean) as string[]);
  const cardKeys = new Set(cardSources.map((c) => (c.kind === 'rss' ? feedKey(c.ref) : null)).filter(Boolean) as string[]);
  const seen = new Set<string>();
  const out: CardSource[] = [];
  for (const url of urls) {
    const host = hostOf(url);
    const key = feedKey(url);
    if (!host || !key || cardHosts.has(host) || cardKeys.has(key)) continue;
    const kind: CardSource['kind'] = FEEDISH.test(url) ? 'rss' : 'url';
    const dedupe = kind === 'rss' ? key : host;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ id: `${PLAYBOOK_SOURCE_PREFIX}${host}`, kind, ref: url } as CardSource);
  }
  return out;
}

/** The id prefix of a source a playbook series names (`series:<name>`), as `playbook:<host>` is for a feed. */
export const SERIES_SOURCE_PREFIX = 'series:';

/**
 * Spec 076 A23: the library and api sources the playbook's active series name, as `CardSource` rows for source health
 * (`id = series:<name>`, `ref` = the dataset key or the api name). Feed series are left out (`playbookSources` lists them).
 * A (kind, ref) the card already lists is skipped, and there is one row per (kind, ref): the first series that names it.
 */
export function playbookSeriesSources(body: unknown, cardSources: CardSource[] = []): CardSource[] {
  const pb = body && typeof body === 'object' ? body as { series?: unknown } : {};
  const have = new Set(cardSources.map((c) => `${c.kind}|${c.ref}`));
  const out: CardSource[] = [];
  for (const s of Array.isArray(pb.series) ? pb.series as Array<Record<string, any>> : []) {
    if (s?.active === false || typeof s?.name !== 'string' || !s.name.trim()) continue;
    const src = s.source;
    const kind = src?.kind === 'library' || src?.kind === 'api' ? src.kind as 'library' | 'api' : null;
    const ref = kind === 'library' ? src.table : kind === 'api' ? src.source : null;
    if (!kind || typeof ref !== 'string' || !ref.trim() || have.has(`${kind}|${ref}`)) continue;
    have.add(`${kind}|${ref}`);
    out.push({ id: `${SERIES_SOURCE_PREFIX}${s.name.trim()}`, kind, ref } as CardSource);
  }
  return out;
}
