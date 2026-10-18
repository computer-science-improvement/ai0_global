import type { CardSource } from '../card';
import { feedKey, hostOf, type HostFailures } from '../net/host-failures';
import type { FeedItem } from '../live/feed-items';

/**
 * Spec 049 FR-004: a source change the channel agent proposes and the owner applies — replace a failing source, add
 * an extra one, or remove a dead one. The candidate is read by code before the card exists, so the owner never gets a
 * replacement that does not work either.
 */

export const SOURCE_CHANGE_KIND = 'change_source';
export type SourceChangeAction = 'replace' | 'add' | 'remove';
export type NewCardSource = Omit<CardSource, 'id'> & { id?: string };

export interface SourceChange {
  channelKey: string;
  action:     SourceChangeAction;
  /** The card source replaced or removed (its id). */
  sourceId?:  string | null;
  /** The new source (replace / add); without an id one is made (a replacement keeps the old one). */
  source?:    NewCardSource | null;
  reason:     string;
}

/** A feed newer than this (its newest dated item) is alive. */
export const CANDIDATE_FRESH_DAYS = 30;

const slug = (s: string): string => s.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'source';

/** A free id for a new source: the given one, else from its host / name, suffixed when taken. */
export function sourceIdFor(source: Pick<NewCardSource, 'id' | 'kind' | 'ref'>, taken: readonly string[]): string {
  const base = (source.id?.trim() || slug(hostOf(source.ref) ?? source.ref)).slice(0, 60);
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 100; n++) if (!taken.includes(`${base}_${n}`)) return `${base}_${n}`;
  return `${base}_${Date.now() % 10_000}`;
}

/** The same source address (feed key for feeds and pages, the name for api / library). */
export function sameSource(a: Pick<CardSource, 'kind' | 'ref'>, b: Pick<CardSource, 'kind' | 'ref'>): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'rss' || a.kind === 'url' ? feedKey(a.ref) === feedKey(b.ref) : a.ref.trim() === b.ref.trim();
}

/** The card's sources after the change, or why it cannot be made (the card changed since it was proposed). */
export function applySourceChange(sources: CardSource[], c: Pick<SourceChange, 'action' | 'sourceId' | 'source'>): CardSource[] | { error: string; details: string } {
  const at = c.sourceId ? sources.findIndex((s) => s.id === c.sourceId) : -1;
  if ((c.action === 'replace' || c.action === 'remove') && at < 0) {
    return { error: 'unknown_source', details: `the card has no source "${c.sourceId ?? ''}" (sources: ${sources.map((s) => s.id).join(', ') || 'none'})` };
  }
  if (c.action === 'remove') return sources.filter((_, i) => i !== at);
  if (!c.source) return { error: 'source_required', details: `${c.action} needs the new source` };
  const dup = sources.find((s, i) => i !== at && sameSource(s, c.source!));
  if (dup) return { error: 'already_a_source', details: `the card already reads this as "${dup.id}"` };
  const others = sources.filter((_, i) => i !== at).map((s) => s.id);
  // A replacement keeps the replaced source's id (playbook series and slot hints name sources by id).
  const id = c.action === 'replace' && !c.source.id?.trim() ? sources[at].id : sourceIdFor(c.source, others);
  const next: CardSource = { ...c.source, id };
  if (c.action === 'replace') return sources.map((s, i) => (i === at ? next : s));
  return [...sources, next];
}

export interface CandidateDeps {
  readFeed?: (url: string) => Promise<{ items: Array<Pick<FeedItem, 'age_hours'>> }>;
  page?:     (url: string) => Promise<{ status: number }>;
  /** Items the fetch_api source returns with its default parameters. */
  api?:      (name: string) => Promise<number>;
  /** An active dataset and its rows (null when there is no such dataset). */
  dataset?:  (key: string) => Promise<{ active: boolean; rows: number } | null>;
  hosts?:    Pick<HostFailures, 'blocked'>;
}

export type CandidateCheck = { ok: true; evidence: string } | { ok: false; error: string; details: string };

const errText = (err: unknown): string => String((err as { message?: string } | null)?.message ?? err).slice(0, 200);

/** Read the candidate once: a live feed with recent items, a page that answers, an api with items, a dataset with rows. */
export async function checkCandidate(s: Pick<CardSource, 'kind' | 'ref'>, d: CandidateDeps): Promise<CandidateCheck> {
  const host = s.kind === 'rss' || s.kind === 'url' ? hostOf(s.ref) : null;
  if ((s.kind === 'rss' || s.kind === 'url') && !host) return { ok: false, error: 'invalid_url', details: 'rss / url sources need an http(s) URL' };
  if (host && d.hosts) {
    const b = (await d.hosts.blocked(host, s.kind === 'rss' ? 'feed' : 'page'))
      ?? (s.kind === 'rss' ? await d.hosts.blocked(feedKey(s.ref)!, 'feed') : null);
    if (b) return { ok: false, error: 'candidate_blocked', details: `${b.host} is blocked until ${b.until.toISOString().slice(0, 16)}Z (${b.reason}) — pick another source` };
  }
  try {
    switch (s.kind) {
      case 'rss': {
        if (!d.readFeed) return { ok: false, error: 'not_checked', details: 'feeds cannot be checked here' };
        const f = await d.readFeed(s.ref);
        if (!f.items.length) return { ok: false, error: 'candidate_empty', details: 'the feed has no items' };
        const ages = f.items.map((i) => i.age_hours).filter((h): h is number => h !== null);
        const newest = ages.length ? Math.min(...ages) : null;
        if (newest !== null && newest > CANDIDATE_FRESH_DAYS * 24) {
          return { ok: false, error: 'candidate_stale', details: `the newest item is ${Math.round(newest / 24)} d old` };
        }
        return { ok: true, evidence: `${f.items.length} items${newest !== null ? `, newest ${newest < 48 ? `${Math.round(newest)} h` : `${Math.round(newest / 24)} d`} old` : ''}` };
      }
      case 'url': {
        if (!d.page) return { ok: false, error: 'not_checked', details: 'pages cannot be checked here' };
        const r = await d.page(s.ref);
        return r.status < 400 ? { ok: true, evidence: `the page answers (status ${r.status})` } : { ok: false, error: 'candidate_http_error', details: `status ${r.status}` };
      }
      case 'api': {
        if (!d.api) return { ok: false, error: 'not_checked', details: 'api sources cannot be checked here' };
        const n = await d.api(s.ref);
        return n > 0 ? { ok: true, evidence: `${n} items` } : { ok: false, error: 'candidate_empty', details: 'the api returned no items' };
      }
      case 'library': {
        if (!d.dataset) return { ok: false, error: 'not_checked', details: 'datasets cannot be checked here' };
        const ds = await d.dataset(s.ref);
        if (!ds || !ds.active) return { ok: false, error: 'unknown_dataset', details: `no active dataset "${s.ref}"` };
        return ds.rows > 0 ? { ok: true, evidence: `${ds.rows} rows` } : { ok: false, error: 'candidate_empty', details: 'the dataset has no rows' };
      }
    }
  } catch (err) {
    return { ok: false, error: 'candidate_failed', details: errText(err) };
  }
}

/** The card text of a source ("rss https://…"). */
export const sourceLabel = (s: Pick<CardSource, 'kind' | 'ref'>): string => `${s.kind} ${s.ref}`;
