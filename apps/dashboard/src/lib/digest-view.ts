// Spec 078 D4: the pure parts of the KPI digest block on /app/health (components/health/DigestSection.tsx) — which resources
// come first, what the strip counts, how a KPI value and its change read. No React, node-tested (digest-view.test.ts).

import type { DigestResource, KpiDigest, KpiName, KpiValue } from '../api/manager';
import { flaggedCount } from './quality-view';

/** Anomalies plus quality flags of a resource: what makes it "flagged". */
export function issueCount(r: Pick<DigestResource, 'anomalies' | 'quality'>): number {
  return r.anomalies.length + (r.quality?.flags.length ?? 0);
}

/** Flagged resources first, the most flagged first; resources with the same count keep the digest's order. */
export function sortByIssues<T extends Pick<DigestResource, 'anomalies' | 'quality'>>(resources: readonly T[]): T[] {
  return resources
    .map((r, i) => ({ r, i, n: issueCount(r) }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map((x) => x.r);
}

/** What a phone shows: only the flagged resources, until the "N healthy" toggle is opened. `sorted` is `sortByIssues` output. */
export function visibleResources<T extends Pick<DigestResource, 'anomalies' | 'quality'>>(sorted: readonly T[], phone: boolean, showAll: boolean): T[] {
  return phone && !showAll ? sorted.filter((r) => issueCount(r) > 0) : [...sorted];
}

export interface DigestSummary {
  resources: number;
  /** Resources with an anomaly or a quality flag. */
  flagged: number;
  healthy: number;
  /** KPI anomalies across the network. */
  anomalies: number;
  /** Resources whose content quality the code flagged. */
  qualityFlagged: number;
  /** Open directives, and the ones that wait for the owner (awaiting_owner, contested). */
  open: number;
  awaiting: number;
  spentTodayUsd: number;
}

export function summarize(dg: Pick<KpiDigest, 'resources' | 'directives' | 'budget'>): DigestSummary {
  const flagged = dg.resources.filter((r) => issueCount(r) > 0).length;
  return {
    resources: dg.resources.length,
    flagged,
    healthy: dg.resources.length - flagged,
    anomalies: dg.resources.reduce((s, r) => s + r.anomalies.length, 0),
    qualityFlagged: flaggedCount(dg.resources),
    open: dg.directives.open.length,
    awaiting: dg.directives.open.filter((d) => d.status === 'awaiting_owner' || d.status === 'contested').length,
    spentTodayUsd: dg.budget.spentTodayUsd,
  };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The link line of the directives tile: how many wait for the owner (awaiting_owner, contested). */
export function awaitingLine(awaiting: number): string {
  return awaiting ? `${awaiting} ${plural(awaiting, 'awaits', 'await')} you` : 'none wait for you';
}

/** The toggle under the tiles on a phone: "3 healthy resources", or the way back. */
export function healthyToggleLabel(healthy: number, showAll: boolean): string {
  return showAll ? 'Show only flagged' : `${healthy} healthy ${plural(healthy, 'resource', 'resources')}`;
}

/** A KPI value for a tile: 7-day value, compact above 10 000, signed growth, % and ₴ where they belong. */
export function fmtKpi(name: KpiName, v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const compact = (n: number) => (Math.abs(n) >= 10_000 ? `${(n / 1000).toFixed(Math.abs(n) >= 100_000 ? 0 : 1)}K` : Number(n.toFixed(n % 1 && Math.abs(n) < 100 ? 1 : 0)).toLocaleString('en-US'));
  switch (name) {
    case 'engagement_rate':  return `${v.toFixed(v < 10 ? 2 : 1)}%`;
    case 'followers_growth': return `${v > 0 ? '+' : v < 0 ? '−' : ''}${compact(Math.abs(v))}`;
    case 'revenue':          return `₴${compact(v)}`;
    default:                 return compact(v);
  }
}

export type DeltaTone = 'up' | 'down' | 'flat';

/** Direction of a KPI's change against the 28-day baseline; a stale or missing KPI, or no change, is flat. */
export function deltaTone(k: Pick<KpiValue, 'd' | 'stale'> | undefined): DeltaTone {
  const d = k?.d ?? null;
  if (k?.stale || d == null || d === 0) return 'flat';
  return d > 0 ? 'up' : 'down';
}

/** The tooltip of a KPI: 7-day value, baseline, z-score and flags. */
export function kpiTitle(name: KpiName, label: string, k: KpiValue | undefined): string {
  if (!k) return `${label}: no data`;
  return `${label}: 7-day ${fmtKpi(name, k.v)} · 28-day baseline ${fmtKpi(name, k.base)}${k.z != null ? ` · z ${k.z}` : ''}${k.stale ? ' · stale (no fresh data)' : ''}${k.anomaly ? ' · anomaly' : ''}`;
}
