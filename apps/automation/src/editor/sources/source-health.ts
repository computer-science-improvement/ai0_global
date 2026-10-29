import type { CardSource } from '../card';
import { feedKey, hostOf } from '../net/host-failures';
import type { ProbeSummary } from './probe';
import { SERIES_SOURCE_PREFIX } from './playbook-feeds';

/**
 * Spec 049 FR-003: how each source of a channel card actually behaves — read from the run trace (`editor_run_steps`,
 * kept 30 days) and the blocked-host memory (`source_host_failures`). Pure: the repository reads the rows, this
 * decides. A source is matched by the tool that reads it: rss → fetch_feed of that feed address, url → page tools on
 * that host, api → fetch_api of that source name, library → query_data / search_library of that dataset.
 */

/** Tools whose steps can belong to a source. */
export const SOURCE_TOOLS = ['fetch_feed', 'web_fetch', 'extract_images', 'fetch_api', 'query_data', 'search_library'] as const;
const PAGE_TOOLS = new Set(['web_fetch', 'extract_images', 'fetch_feed']);

export const SOURCE_HEALTH_DAYS = 14;
/** At least this many failed calls, under half successful, is a failing source. */
export const FAILING_MIN_ERRORS = 3;
/** This many calls in a row that failed (or came back empty) decide the state by themselves. */
export const STREAK = 3;

/** One tool step of the channel's runs (the repository reads only what this needs). */
export interface SourceStep {
  at:         Date;
  tool:       string;
  input:      Record<string, unknown> | null;
  isError:    boolean;
  error:      string | null;
  details:    string | null;
  /** Items / rows the call returned; null when unknown (a truncated trace, an error). */
  items:      number | null;
  slotId:     string | null;
  slotStatus: string | null;
}

/** A row of source_host_failures (`host` is a host, or host + path for a feed address). */
export interface HostBlockRow {
  host:       string;
  reason:     string;
  statusCode: number | null;
  until:      Date;
  failures:   number;
  /** Blocks in a row (spec 061 FR-004); a row from before it has none. */
  strikes?:   number;
}

export type SourceState = 'blocked' | 'failing' | 'exhausted' | 'ok' | 'unused';

/** Spec 076 A23: the material a dataset source has left on the channel's resource (from the catalog overview). */
export interface SourceRunway {
  /** Rows not yet posted here (null = unknown). */
  unposted: number | null;
  /** Days of material at the current pace; null for a dataset that repeats in rounds, or when nothing uses it. */
  days:     number | null;
  /** The dataset repeats in rounds, so it never runs out. */
  rounds:   boolean;
}

export interface SourceHealth {
  id:          string;
  /**
   * `playbook` - a feed the orchestrator's playbook reads that the card does not list (spec 061 FR-004), or (spec 076 A23) a
   * dataset / api a playbook series names (`id = series:<name>`). Absent = a card source.
   */
  origin?:     'card' | 'playbook';
  kind:        CardSource['kind'];
  ref:         string;
  state:       SourceState;
  calls:       number;
  ok:          number;
  empty:       number;
  errors:      number;
  /** Successful calls / calls (null without calls). */
  successRate: number | null;
  lastOkAt:    string | null;
  lastError:   { at: string; code: string; details: string | null } | null;
  blocked:     { host: string; reason: string; statusCode: number | null; until: string; failures: number; strikes: number } | null;
  /** Slots that ended skipped or failed after this source failed them (and never answered in that slot). */
  slotsLost:   number;
  /** One English line for the dashboard, the agent's prompt and the report. */
  detail:      string;
  /** Spec 076: the latest read of an `rss` / `url` source from the server (null = never read); absent on a report from before it. */
  probe?:      ProbeSummary | null;
  /** Spec 076 A23: material left of a `library` source; null for the other kinds. */
  runway?:     SourceRunway | null;
}

export interface SourceHealthReport {
  channelKey: string;
  days:       number;
  sources:    SourceHealth[];
  /** Hosts outside the card's sources that the channel's runs hit while they are blocked. */
  otherHosts: Array<{ host: string; reason: string; statusCode: number | null; until: string; calls: number }>;
  /** Spec 076: the card and its playbook name no source at all - the channel writes from its brief only. */
  noSources:  boolean;
  /** Spec 076: an egress proxy is configured (the panel offers "Route via proxy" only then). */
  proxyConfigured: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Does this step read this source? */
export function stepMatches(s: CardSource, step: Pick<SourceStep, 'tool' | 'input'>): boolean {
  const i = step.input ?? {};
  switch (s.kind) {
    case 'rss': {
      const url = str(i.url);
      return step.tool === 'fetch_feed' && !!url && feedKey(url) === feedKey(s.ref);
    }
    case 'url': {
      const url = str(i.url);
      return PAGE_TOOLS.has(step.tool) && !!url && hostOf(url) === hostOf(s.ref);
    }
    case 'api':
      return step.tool === 'fetch_api' && i.source === s.ref;
    case 'library':
      return (step.tool === 'query_data' && i.schema === s.ref) || (step.tool === 'search_library' && i.table === s.ref);
  }
}

const failed = (st: SourceStep): boolean => st.isError || !!st.error;

/**
 * The active block that stops this source (the host for pages, the host or the feed address for a feed). The same rule as
 * `PgHostFailures.blocked`: a feed row stops feeds only, and a host `refused` row (a page answered 403) does not stop a feed (spec 070).
 */
function blockOf(s: CardSource, blocks: HostBlockRow[], now: Date): HostBlockRow | null {
  if (s.kind !== 'rss' && s.kind !== 'url') return null;
  const host = hostOf(s.ref);
  const key = s.kind === 'rss' ? feedKey(s.ref) : null;
  return blocks.find((b) => b.until > now && (
    (b.host === host && !(s.kind === 'url' && b.reason.startsWith('feed_')) && !(s.kind === 'rss' && b.reason === 'refused'))
    || (key !== null && b.host === key))) ?? null;
}

function ago(at: Date, now: Date): string {
  const h = Math.max(0, (now.getTime() - at.getTime()) / 3_600_000);
  return h < 1 ? 'under an hour ago' : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} d ago`;
}

/** The health of one source from the steps that read it. */
export function sourceHealthOf(s: CardSource, steps: SourceStep[], blocks: HostBlockRow[], now: Date, days = SOURCE_HEALTH_DAYS): SourceHealth {
  const own = steps.filter((st) => stepMatches(s, st)).sort((a, b) => a.at.getTime() - b.at.getTime());
  const errors = own.filter(failed);
  const okSteps = own.filter((st) => !failed(st));
  const empty = okSteps.filter((st) => st.items === 0).length;
  const lastOk = [...okSteps].reverse().find((st) => st.items !== 0) ?? null;
  const lastErr = errors[errors.length - 1] ?? null;
  const block = blockOf(s, blocks, now);
  const tail = own.slice(-STREAK);

  // Slots this source failed: a call errored in the slot's runs, none answered there, and the slot did not go out.
  const lost = new Set<string>();
  const answered = new Set(okSteps.map((st) => st.slotId).filter(Boolean));
  for (const st of errors) {
    if (st.slotId && !answered.has(st.slotId) && (st.slotStatus === 'skipped' || st.slotStatus === 'failed')) lost.add(st.slotId);
  }

  const rate = own.length ? okSteps.length / own.length : null;
  const state: SourceState = block ? 'blocked'
    : (errors.length >= FAILING_MIN_ERRORS && (rate ?? 0) < 0.5) || (tail.length === STREAK && tail.every(failed)) ? 'failing'
    : tail.length === STREAK && tail.every((st) => !failed(st) && st.items === 0) ? 'exhausted'
    : own.length ? 'ok' : 'unused';

  const parts: string[] = [];
  if (block) parts.push(`blocked until ${block.until.toISOString().slice(0, 16).replace('T', ' ')} UTC (${block.reason}${block.statusCode ? ` ${block.statusCode}` : ''}${(block.strikes ?? 0) > 1 ? `, ${block.strikes} blocks in a row` : ''})`);
  if (own.length) parts.push(`${okSteps.length} of ${own.length} reads worked in ${days} d`);
  else parts.push(`not read in ${days} d`);
  if (state === 'exhausted') parts.push(`the last ${STREAK} reads found nothing new`);
  if (lastErr) parts.push(`last error ${ago(lastErr.at, now)}: ${lastErr.error ?? 'error'}${lastErr.details ? ` — ${lastErr.details.slice(0, 120)}` : ''}`);
  if (lastOk) parts.push(`last good read ${ago(lastOk.at, now)}`);
  else if (own.length) parts.push('no good read');
  if (lost.size) parts.push(`${lost.size} slot${lost.size === 1 ? '' : 's'} lost`);

  return {
    id: s.id, kind: s.kind, ref: s.ref, state,
    calls: own.length, ok: okSteps.length, empty, errors: errors.length,
    successRate: rate === null ? null : Math.round(rate * 100) / 100,
    lastOkAt: lastOk ? lastOk.at.toISOString() : null,
    lastError: lastErr ? { at: lastErr.at.toISOString(), code: lastErr.error ?? 'error', details: lastErr.details } : null,
    blocked: block ? { host: block.host, reason: block.reason, statusCode: block.statusCode, until: block.until.toISOString(), failures: block.failures, strikes: block.strikes ?? 0 } : null,
    slotsLost: lost.size,
    detail: parts.join('; '),
  };
}

const STATE_ORDER: Record<SourceState, number> = { blocked: 0, failing: 1, exhausted: 2, ok: 3, unused: 4 };

/** Worst first (a failed server read counts as trouble inside the `ok` / `unused` groups). */
export function orderSources(list: SourceHealth[]): SourceHealth[] {
  const bad = (h: SourceHealth) => (h.probe && !h.probe.ok ? 0 : 1);
  return [...list].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || bad(a) - bad(b) || b.errors - a.errors);
}

/** The report of a channel: every card source (worst first) and the blocked hosts its runs hit outside them. */
export function sourceHealthReport(
  channelKey: string, sources: CardSource[], steps: SourceStep[], blocks: HostBlockRow[], now: Date, days = SOURCE_HEALTH_DAYS,
): SourceHealthReport {
  const health = orderSources(sources.map((s) => sourceHealthOf(s, steps, blocks, now, days)));
  const own = new Set(sources.flatMap((s) => [hostOf(s.ref), s.kind === 'rss' ? feedKey(s.ref) : null]).filter(Boolean) as string[]);
  const hits = new Map<string, number>();
  for (const st of steps) {
    const url = str(st.input?.url);
    const host = url ? hostOf(url) : null;
    if (!host || own.has(host)) continue;
    hits.set(host, (hits.get(host) ?? 0) + 1);
  }
  const otherHosts = blocks
    .filter((b) => b.until > now && hits.has(b.host))
    .map((b) => ({ host: b.host, reason: b.reason, statusCode: b.statusCode, until: b.until.toISOString(), calls: hits.get(b.host)! }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 10);
  return { channelKey, days, sources: health, otherHosts, noSources: sources.length === 0, proxyConfigured: false };
}

/** Sources the owner should see as not working: blocked, failing or exhausted, or the server's own read of the address failed (spec 076 A22). */
export const isTroubled = (h: SourceHealth): boolean =>
  h.state === 'blocked' || h.state === 'failing' || h.state === 'exhausted' || (!!h.probe && !h.probe.ok);

/** A dataset source of a playbook series whose rows are all posted and that does not repeat in rounds (spec 076 A22). */
export const isSeriesExhausted = (h: Pick<SourceHealth, 'id' | 'kind' | 'runway'>): boolean =>
  h.kind === 'library' && h.id.startsWith(SERIES_SOURCE_PREFIX) && !!h.runway && !h.runway.rounds && h.runway.unposted === 0;

/**
 * Spec 076: the health row with the server's latest read of its address and the material left. A failed read adds a line to
 * `detail`; a series library source with no unposted rows and no rounds is `exhausted` (unless a worse state already holds).
 */
export function withReach(h: SourceHealth, o: { probe?: ProbeSummary | null; runway?: SourceRunway | null }): SourceHealth {
  const probe = (h.kind === 'rss' || h.kind === 'url') ? (o.probe ?? null) : null;
  const runway = h.kind === 'library' ? (o.runway ?? null) : null;
  let out: SourceHealth = { ...h, probe, runway };
  if (probe && !probe.ok) out = { ...out, detail: `${out.detail}; the server could not read it (${probe.failure_class ?? 'error'}: ${probe.detail})` };
  if (isSeriesExhausted(out) && out.state !== 'blocked' && out.state !== 'failing') {
    out = { ...out, state: 'exhausted', detail: 'no unposted rows left' };
  }
  return out;
}

/**
 * Sources worth a replacement: failing or exhausted, or blocked again and again (one 24-hour block is a blip — a site
 * that refused twice in a row, or a block on top of failed reads, is not). An `unreachable` block (spec 076: three timeouts
 * in a row, at least two hours of failures) counts at its first strike.
 */
export const needsReplacement = (h: SourceHealth): boolean =>
  h.state === 'failing' || h.state === 'exhausted'
  || (h.state === 'blocked' && h.blocked?.reason !== 'timeout'
    && ((h.blocked?.failures ?? 1) >= 2 || (h.blocked?.strikes ?? 0) >= 2 || h.errors >= FAILING_MIN_ERRORS || h.blocked?.reason === 'unreachable'));

/** The hosts and feed addresses a card's sources (and the steps' urls) can be blocked under. */
export function blockKeys(sources: CardSource[], steps: SourceStep[]): string[] {
  const keys = new Set<string>();
  for (const s of sources) {
    const h = hostOf(s.ref);
    if (h) keys.add(h);
    const k = s.kind === 'rss' ? feedKey(s.ref) : null;
    if (k) keys.add(k);
  }
  for (const st of steps) {
    const url = str(st.input?.url);
    const h = url ? hostOf(url) : null;
    if (h) keys.add(h);
  }
  return [...keys];
}
