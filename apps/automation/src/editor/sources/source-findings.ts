import type { Finding } from '../sysadmin/audit.types';
import { findingKey } from '../sysadmin/audit-text';
import { sourceReason } from './codes';
import type { HostProxyAddFix, SourceDropFix } from './source-fixes';

/**
 * Spec 076 FR-008 / L6 / A4: the doctor's source checks as one pure function. It reads no database and no network and calls no
 * clock: everything it needs is in the input, which the lead's facts loader fills (and wraps this into `readiness/checks/sources.ts`
 * at merge). W1 isolation (L10): nothing here imports the readiness or reasons code; the types below are 076's own copies.
 *
 * Per source at most one finding, in this order of precedence:
 *   `source_probe_failed` (error when the source is required, else warn) — the latest fresh probe failed with any class but `empty`,
 *     or the host is blocked as `unreachable`;
 *   `source_empty` (warn) — the probe failed as `empty`, or an `rss` source's newest item is over 7 days old;
 *   `source_untested` (info) — an `rss` / `url` source with no fresh probe, on a channel created in the last 14 days.
 * Per channel: `card_without_sources` (info), and one `dataset_resync_manual` (info) for each dataset bound to an uploaded page.
 * A probe older than 7 days counts as none (A4). Only `rss` and `url` sources are read from the server: a library or api source
 * never gets a probe finding.
 */

/** The part of a probe the checks decide on (L6): a subset of `ProbeResult`, plus the display line when there is one. */
export interface SourceProbeFact {
  ok:            boolean;
  failure_class: string | null;
  items:         number | null;
  newest_at:     string | null;
  checked_at:    string;
  detail?:       string;
}

/** 072 FR-012's `SourceFact` with its two optional fields (L6), and the card source's id (delta: `source_drop` needs it). */
export interface SourceFact {
  url:        string;
  kind:       'rss' | 'url' | 'library' | 'api';
  origin:     'card' | `series:${string}`;
  host:       string | null;
  hostBlock:  { reason: string; until: string; strikes: number } | null;
  /** The card source's id, for `origin: 'card'`. Without it the fix names the source by its address. */
  id?:        string;
  /** A required series' source, or the card's only source. */
  required?:  boolean;
  /** `PgSourceProbes.latest`. */
  probe?:     SourceProbeFact | null;
}

export interface SourceFindingsInput {
  channelKey:       string;
  /** The orchestrator's handle (without "@"), for the links; null when the channel has no agent yet. */
  agent:            string | null;
  now:              Date;
  createdAt:        Date;
  sources:          SourceFact[];
  proxyConfigured:  boolean;
  /** The dataset keys already bound to the channel whose latest list import is an upload (the facts loader filters them). */
  uploadedImports:  string[];
}

export type SourceFix = SourceDropFix | HostProxyAddFix;

/** `Finding` with the channel area (A4: `AUDIT_AREAS` has none, and extending it is 072's job) and the fix and link of this seam. */
export type SourceFinding = Omit<Finding, 'area' | 'fix'> & { area: 'channel'; fix?: SourceFix; link: string };

export const SOURCE_FINDING_CODES = ['source_probe_failed', 'source_empty', 'source_untested', 'card_without_sources', 'dataset_resync_manual'] as const;
export type SourceFindingCode = typeof SOURCE_FINDING_CODES[number];

/** A probe older than this counts as no probe. */
export const PROBE_FRESH_DAYS = 7;
/** An `rss` probe whose newest item is older than this is `source_empty`. */
export const FEED_STALE_DAYS = 7;
/** `source_untested` is only said of a channel created this recently. */
export const UNTESTED_CHANNEL_DAYS = 14;

const DAY = 86_400_000;
const SEVERITY_RANK = { info: 0, warn: 1, error: 2 } as const;
const isReadFromServer = (kind: SourceFact['kind']): boolean => kind === 'rss' || kind === 'url';
const en = (code: SourceFindingCode): string => sourceReason(code)?.en ?? code;

const when = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC` : iso;
};

/** The probe if it is fresh enough to decide on, else null. */
function freshProbe(f: SourceFact, now: Date): SourceProbeFact | null {
  const p = f.probe;
  if (!p) return null;
  const at = Date.parse(p.checked_at);
  if (!Number.isFinite(at) || now.getTime() - at > PROBE_FRESH_DAYS * DAY) return null;
  return p;
}

type Verdict =
  | { code: 'source_probe_failed'; classes: string[]; cause: SourceProbeFact | null }
  | { code: 'source_empty' | 'source_untested'; cause: SourceProbeFact | null };

/** What to say about one source, or null when it is fine (or is not read from the server). */
function verdictOf(f: SourceFact, probe: SourceProbeFact | null, o: { now: Date; createdAt: Date }): Verdict | null {
  if (!isReadFromServer(f.kind)) return null;
  const probeFailed = !!probe && !probe.ok && probe.failure_class !== 'empty';
  const unreachable = f.hostBlock?.reason === 'unreachable';
  if (probeFailed || unreachable) {
    // An unreachable block is repeated timeouts, so it counts as a timeout when the probe says nothing else.
    const classes = [...(probeFailed ? [probe!.failure_class ?? 'unknown'] : []), ...(unreachable && !probeFailed ? ['timeout'] : [])];
    return { code: 'source_probe_failed', classes, cause: probeFailed ? probe : null };
  }
  if (probe && !probe.ok) return { code: 'source_empty', cause: probe };
  if (probe && probe.ok && f.kind === 'rss' && probe.newest_at) {
    const newest = Date.parse(probe.newest_at);
    if (Number.isFinite(newest) && o.now.getTime() - newest > FEED_STALE_DAYS * DAY) return { code: 'source_empty', cause: probe };
  }
  if (!probe && o.now.getTime() - o.createdAt.getTime() <= UNTESTED_CHANNEL_DAYS * DAY) return { code: 'source_untested', cause: null };
  return null;
}

export function sourceFindings(input: SourceFindingsInput): SourceFinding[] {
  const { channelKey, agent, now } = input;
  const settingsLink = agent ? `/app/agents/${agent}?tab=settings` : `/app/editor/${channelKey}`;
  const subjectOf = (id: string, label: string): SourceFinding['subject'] => ({ type: 'channel', id, label, agent: agent ?? undefined, channel: channelKey });

  const byKey = new Map<string, SourceFinding>();
  const add = (f: SourceFinding): void => {
    const prev = byKey.get(f.key);
    if (!prev) { byKey.set(f.key, f); return; }
    // The same address listed twice (the card and a series): one finding, with the higher severity and a fix if either has one.
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[prev.severity]) prev.severity = f.severity;
    prev.fix ??= f.fix;
  };

  for (const f of input.sources) {
    const probe = freshProbe(f, now);
    const v = verdictOf(f, probe, { now, createdAt: input.createdAt });
    if (!v) continue;
    const label = f.host ?? f.url;
    const subject = subjectOf(`${channelKey}|${f.url}`, label);
    const code = v.code;

    let fix: SourceFix | undefined;
    if (v.code === 'source_probe_failed') {
      const proxyable = v.classes.some((c) => c === 'timeout' || c === 'refused');
      if (input.proxyConfigured && proxyable && f.host) fix = { kind: 'host_proxy_add', host: f.host };
    }
    if (!fix && code !== 'source_untested' && f.origin === 'card') fix = { kind: 'source_drop', channel: channelKey, sourceId: f.id ?? f.url };

    const detail = v.cause?.detail
      || (code === 'source_probe_failed' && f.hostBlock
        ? `blocked until ${when(f.hostBlock.until)} (${f.hostBlock.reason}, ${f.hostBlock.strikes} in a row)`
        : en(code));
    const title = code === 'source_probe_failed' ? `${label}: the server cannot read this source`
      : code === 'source_empty' ? `${label}: empty or not a feed`
        : `${label}: not read from the server yet`;

    add({
      key: findingKey('channel', code, subject), area: 'channel', check: code,
      severity: code === 'source_probe_failed' ? (f.required ? 'error' : 'warn') : code === 'source_empty' ? 'warn' : 'info',
      subject, title, detail,
      evidence: {
        url: f.url, kind: f.kind, origin: f.origin, failure_class: probe?.failure_class ?? null, items: probe?.items ?? null,
        newest_at: probe?.newest_at ?? null, checked_at: probe?.checked_at ?? null, block: f.hostBlock,
      },
      ...(fix ? { fix } : {}), link: settingsLink,
    });
  }

  if (!input.sources.length) {
    const subject = subjectOf(channelKey, channelKey);
    add({
      key: findingKey('channel', 'card_without_sources', subject), area: 'channel', check: 'card_without_sources', severity: 'info', subject,
      title: `No sources: ${channelKey} writes from its brief only`, detail: en('card_without_sources'), evidence: {}, link: settingsLink,
    });
  }

  for (const dataset of new Set(input.uploadedImports.filter(Boolean))) {
    const subject = subjectOf(`${channelKey}|${dataset}`, dataset);
    add({
      key: findingKey('channel', 'dataset_resync_manual', subject), area: 'channel', check: 'dataset_resync_manual', severity: 'info', subject,
      title: `${dataset}: re-sync is manual (uploaded page)`, detail: en('dataset_resync_manual'), evidence: { dataset }, link: `/app/data/${dataset}`,
    });
  }

  return [...byKey.values()];
}
