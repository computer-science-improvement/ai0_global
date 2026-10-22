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
const FEEDISH = /(^|[/._-])(rss|atom|feed|feeds)([/._?-]|$)|\.xml(\?|$)/i;

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
