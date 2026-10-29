// Spec 076 FR-009: what the Sources panel (agent Settings) and the Health page say about the SERVER's own read of a source:
// the "Server read: …" line, its tone, the "Unreachable" badge, which row buttons a source gets, the library runway line,
// and the owner-facing text of the errors the four source endpoints answer. Pure: no React, so it is node-tested.

import type { Tone } from '../components/ui/primitives';
import type { SourceHealth, SourceProbe, SourceRunway } from '../api/agents';

type RowSource = Pick<SourceHealth, 'kind' | 'origin' | 'probe' | 'blocked'>;

/** An `rss` or `url` source is the only kind the server can read to see whether it answers. */
export const isReadFromServer = (s: Pick<SourceHealth, 'kind'>): boolean => s.kind === 'rss' || s.kind === 'url';
/** Three timeouts in a row make the host `unreachable` (a block of 1, 3, then 7 days). */
export const isUnreachable = (s: Pick<SourceHealth, 'blocked'>): boolean => s.blocked?.reason === 'unreachable';
export const probeFailed = (p: SourceProbe | null | undefined): boolean => !!p && !p.ok;

/** "just now", "5 min ago", "3 h ago", "2 d ago". `now` is a parameter so the line can be tested. */
export function ageText(iso: string | null | undefined, now: number = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 'unknown time';
  const min = Math.floor((now - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

function failureText(p: SourceProbe): string {
  switch (p.failure_class) {
    case 'timeout': return 'timed out twice';
    case 'refused': return p.status ? `refused (HTTP ${p.status})` : 'refused by the site';
    case 'tls':     return 'TLS error';
    case 'dns':     return 'address not found';
    case 'http':    return p.status ? `HTTP ${p.status}` : 'HTTP error';
    case 'empty':   return p.kind === 'rss' ? 'no items in the feed' : 'no text on the page';
    case 'invalid': return 'Not a valid public address';
    default:        return p.detail || 'failed';
  }
}

/**
 * The line under a source: "Server read: OK · 24 items · newest 2 h ago · checked 3 h ago · via proxy", or
 * "Server read: timed out twice · checked 1 h ago". `null` = the server never read it.
 */
export function probeLine(p: SourceProbe | null | undefined, now: number = Date.now()): string {
  if (!p) return 'Server read: not read yet';
  const parts: string[] = [];
  if (p.ok) {
    parts.push('OK');
    if (p.kind === 'rss' || p.items > 0) parts.push(`${p.items} ${p.items === 1 ? 'item' : 'items'}`);
    else parts.push('page');
    if (p.newest_at) parts.push(`newest ${ageText(p.newest_at, now)}`);
  } else {
    parts.push(failureText(p));
  }
  // An address the server refuses to open is never read, so there is no time to report.
  if (p.failure_class !== 'invalid') parts.push(`checked ${ageText(p.checked_at, now)}`);
  if (p.via_proxy) parts.push('via proxy');
  return `Server read: ${parts.join(' · ')}`;
}

/** Green when it answered, amber when it answered with nothing, red when it did not answer; grey when it was never read. */
export function probeTone(p: SourceProbe | null | undefined): Tone {
  if (!p) return 'neutral';
  if (p.ok) return 'success';
  return p.failure_class === 'empty' ? 'warning' : 'danger';
}

/** The ink helper of index.css that colours a line of a tone (neutral is the dim ink). */
export const INK_OF_TONE: Record<Tone, string> = {
  success: 'ink-success', warning: 'ink-warning', danger: 'ink-danger', accent: 'ink-accent', neutral: 'ink-dim',
};

/**
 * The badge that replaces a source's own state when the server's view is worse: "Unreachable" for a host blocked after
 * repeated timeouts, "Cannot be read" for a source whose reads worked in the agent's runs (or never happened) but whose
 * latest read from the server failed. `null`: the state's own badge stands.
 */
export function sourceBadge(s: Pick<SourceHealth, 'state' | 'probe' | 'blocked'>): { label: string; tone: Tone } | null {
  if (isUnreachable(s)) return { label: 'Unreachable', tone: 'danger' };
  if ((s.state === 'ok' || s.state === 'unused') && probeFailed(s.probe)) return { label: 'Cannot be read', tone: 'warning' };
  return null;
}

export type RowFix = 'test' | 'proxy' | 'upload' | 'remove';

/**
 * The buttons a source row gets, in order. "Test from server" is always there for a feed or a page. A failed read or an
 * `unreachable` block adds "Route via proxy" (only when a proxy is configured, and not when the failed read already went
 * through it), "Upload the page" and, for a card source, "Remove". An address that is not valid has nothing to route or upload.
 * A library or api source is not read from the server, so it has no buttons.
 */
export function rowFixes(s: RowSource, o: { proxyConfigured: boolean }): RowFix[] {
  if (!isReadFromServer(s)) return [];
  const out: RowFix[] = ['test'];
  const unreachable = isUnreachable(s);
  if (!probeFailed(s.probe) && !unreachable) return out;
  const invalid = s.probe?.failure_class === 'invalid' && !unreachable;
  if (!invalid) {
    if (o.proxyConfigured && !s.probe?.via_proxy) out.push('proxy');
    out.push('upload');
  }
  if (s.origin !== 'playbook') out.push('remove');
  return out;
}

/** A host name for "Route via proxy" (no leading `www.`), or null for an address that is not a URL. */
export function hostOfRef(ref: string): string | null {
  try {
    const h = new URL(ref).hostname.toLowerCase().replace(/^www\./, '');
    return h || null;
  } catch {
    return null;
  }
}

/** The name a row shows: a series source is stored as `series:<name>`. */
export const sourceName = (s: Pick<SourceHealth, 'id'>): string => (s.id.startsWith('series:') ? s.id.slice('series:'.length) : s.id);

const fmtN = (n: number): string => n.toLocaleString('en-GB');

/**
 * "N rows left · ~D days" for a dataset source, "Repeats in rounds" for a dataset that starts over. The badge is amber under
 * 7 days and red at none. `null`: nothing to say (not a dataset, or the server sent no runway).
 */
export function runwayLine(r: SourceRunway | null | undefined): { text: string; tone: Tone } | null {
  if (!r) return null;
  if (r.rounds) return { text: 'Repeats in rounds', tone: 'neutral' };
  const parts: string[] = [];
  if (r.unposted !== null) parts.push(`${fmtN(r.unposted)} ${r.unposted === 1 ? 'row' : 'rows'} left`);
  if (r.days !== null && r.unposted !== 0) {
    const d = Math.round(r.days);
    parts.push(r.days < 1 ? 'under a day' : `~${d} ${d === 1 ? 'day' : 'days'}`);
  }
  if (!parts.length) return null;
  const none = r.unposted === 0 || r.days === 0;
  return { text: parts.join(' · '), tone: none ? 'danger' : r.days !== null && r.days < 7 ? 'warning' : 'neutral' };
}

/**
 * What the source endpoints answer when they refuse, in words for the owner. `body` is the response text (a JSON
 * `{ error, details? }`). Null when the code is not one of these: the shared error toast then says what it can.
 */
export function sourceErrorMessage(status: number, body: string): string | null {
  let code = '';
  let details = '';
  try {
    const j = JSON.parse(body) as { error?: unknown; details?: unknown };
    code = typeof j.error === 'string' ? j.error : '';
    details = typeof j.details === 'string' ? j.details : '';
  } catch { /* not JSON */ }
  if (status === 413 || code === 'too_large') return 'The page is too large: upload a file under 5 MB (at most 5,000,000 characters).';
  switch (code) {
    case 'proxy_not_configured': return 'No proxy is set up yet. Add EGRESS_PROXY_URL in Settings first.';
    case 'invalid_host':         return 'That host name is not valid.';
    case 'source_not_found':     return 'That source is no longer on the card.';
    case 'channel_not_found':    return 'That channel does not exist.';
    case 'no_list_import':       return 'That dataset was not made by a page import, so there is nothing to re-sync.';
    case 'url_mismatch':         return `The dataset was imported from another address${details ? `: ${details}` : '.'}`;
    case 'unsupported_content':  return 'That file is JSON. Upload a saved HTML, markdown or text page.';
    case 'empty_page':           return 'The page has no text. Check that the saved file is the page itself.';
    default:                     return null;
  }
}
