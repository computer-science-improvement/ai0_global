/**
 * Pure KPI math for the MANAGER digest (spec 021 FR-002). No I/O: callers
 * pass daily series; windows are "recent" = the last 7 complete days and
 * "baseline" = the 28 days before them.
 */

export interface MetricValue {
  /** Recent 7-day value (sum or mean, by metric). */
  value7d:     number | null;
  /** The same quantity over the baseline, scaled to 7 days for sums. */
  baseline28d: number | null;
  deltaPct:    number | null;
  z:           number | null;
  stale:       boolean;
  /** Code-flagged: (|z| ≥ 2 and |Δ| ≥ 10 %) or a drop of ≥ 25 %. */
  anomaly:     boolean;
}

export const ANOMALY_Z = 2;
export const ANOMALY_DROP_PCT = -25;
/** A statistically "significant" move that is still tiny in practice is not an anomaly. */
export const ANOMALY_MIN_ABS_PCT = 10;

export type DailySeries = Map<string, number>; // YYYY-MM-DD → value

/** YYYY-MM-DD of `daysAgo` days before `today` (string math on UTC dates, Kyiv day strings in). */
export function dayBefore(today: string, daysAgo: number): string {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function windowDays(today: string, from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(dayBefore(today, i));
  return out;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function std(xs: number[]): number | null {
  if (xs.length < 3) return null;
  const m = mean(xs)!;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

function finish(value7d: number | null, baseline: number | null, sd: number | null, stale: boolean): MetricValue {
  const deltaPct = value7d != null && baseline != null && baseline !== 0 ? ((value7d - baseline) / Math.abs(baseline)) * 100 : null;
  const z = value7d != null && baseline != null && sd != null && sd > 0 ? (value7d - baseline) / sd : null;
  const anomaly = !stale && (
    (z != null && Math.abs(z) >= ANOMALY_Z && deltaPct != null && Math.abs(deltaPct) >= ANOMALY_MIN_ABS_PCT)
    || (deltaPct != null && deltaPct <= ANOMALY_DROP_PCT));
  return { value7d, baseline28d: baseline, deltaPct, z, stale, anomaly };
}

/**
 * A "mean per active day" metric (views per post, engagement rate): recent =
 * mean of days that have data in days 1–7; baseline = mean of days 8–35; the
 * noise band is the std of baseline daily values scaled to a 7-day mean.
 */
export function meanMetric(series: DailySeries, today: string, minRecentDays = 2): MetricValue {
  const recent = windowDays(today, 1, 7).map((d) => series.get(d)).filter((v): v is number => v != null);
  const base = windowDays(today, 8, 35).map((d) => series.get(d)).filter((v): v is number => v != null);
  const sd = std(base);
  return finish(mean(recent), mean(base), sd != null ? sd / Math.sqrt(Math.max(recent.length, 1)) : null, recent.length < minRecentDays);
}

/**
 * A "sum per week" metric (new followers, revenue, joins): recent = sum of days
 * 1–7; baseline = weekly-equivalent of days 8–35 (missing days count as 0 for
 * revenue/joins, are skipped for followers via `skipMissing`).
 */
export function sumMetric(series: DailySeries, today: string, o: { skipMissing?: boolean; staleIfNoRecent?: boolean } = {}): MetricValue {
  const recentDays = windowDays(today, 1, 7);
  const baseDays = windowDays(today, 8, 35);
  const pick = (days: string[]) => (o.skipMissing ? days.map((d) => series.get(d)).filter((v): v is number => v != null) : days.map((d) => series.get(d) ?? 0));
  const recent = pick(recentDays);
  const base = pick(baseDays);
  const value7d = recent.length ? (recent.reduce((a, b) => a + b, 0) / recent.length) * 7 : null;
  const baseline = base.length ? (base.reduce((a, b) => a + b, 0) / base.length) * 7 : null;
  const sd = std(base);
  const stale = !!o.staleIfNoRecent && recent.length < 2;
  return finish(value7d, baseline, sd != null ? sd * Math.sqrt(7) : null, stale);
}

export interface ScopeKpis {
  views_per_post:   MetricValue;
  engagement_rate:  MetricValue;
  posts:            MetricValue;
  followers_growth: MetricValue;
  transitions:      MetricValue;
  revenue:          MetricValue;
}

export interface ScopeSeries {
  viewsPerPost:  DailySeries;
  engagementRate: DailySeries;
  posts:         DailySeries;
  followerDelta: DailySeries;
  joins:         DailySeries;
  revenue:       DailySeries;
}

export function computeKpis(s: ScopeSeries, today: string): ScopeKpis {
  return {
    views_per_post:   meanMetric(s.viewsPerPost, today),
    engagement_rate:  meanMetric(s.engagementRate, today),
    posts:            sumMetric(s.posts, today),
    followers_growth: sumMetric(s.followerDelta, today, { skipMissing: true, staleIfNoRecent: true }),
    transitions:      sumMetric(s.joins, today),
    revenue:          sumMetric(s.revenue, today),
  };
}

const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);

/** Compact form for the prompt and the hash. */
export function compactKpis(k: ScopeKpis): Record<string, { v: number | null; base: number | null; d: number | null; z: number | null; stale?: true; anomaly?: true }> {
  const out: Record<string, any> = {};
  for (const [name, m] of Object.entries(k)) {
    out[name] = { v: r1(m.value7d), base: r1(m.baseline28d), d: r1(m.deltaPct), z: r1(m.z), ...(m.stale ? { stale: true } : {}), ...(m.anomaly ? { anomaly: true } : {}) };
  }
  return out;
}
