// meta-insights.ts — normalized account-insight metrics + parsing helpers.
// Normalized keys: reach | impressions | profileViews. Each platform maps them to
// its own Graph metric names. Threads only exposes an impressions-equivalent.
import type { MetaPlatform } from './meta-accounts.repository';

export type InsightKey = 'reach' | 'impressions' | 'profileViews';

export interface MetaInsightDay {
  day:          string;          // 'YYYY-MM-DD'
  reach:        number | null;
  impressions:  number | null;
  profileViews: number | null;
}

/** normalized key → the platform's Graph metric name. Missing key = unsupported. */
export const INSIGHT_METRICS: Record<MetaPlatform, Partial<Record<InsightKey, string>>> = {
  instagram: { reach: 'reach', impressions: 'impressions', profileViews: 'profile_views' },
  facebook:  { reach: 'page_impressions_unique', impressions: 'page_impressions', profileViews: 'page_views_total' },
  threads:   { impressions: 'views' },
};

export interface DayValue { day: string; value: number }

/** Fold per-normalized-metric day series into one normalized row per day. */
export function mergeInsightValues(byMetric: Partial<Record<InsightKey, DayValue[]>>): MetaInsightDay[] {
  const days = new Map<string, MetaInsightDay>();
  const ensure = (day: string): MetaInsightDay => {
    let row = days.get(day);
    if (!row) { row = { day, reach: null, impressions: null, profileViews: null }; days.set(day, row); }
    return row;
  };
  for (const key of ['reach', 'impressions', 'profileViews'] as InsightKey[]) {
    for (const dv of byMetric[key] ?? []) ensure(dv.day)[key] = dv.value;
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Parse a Graph insights metric response body into per-day values.
 *  Shape: { data: [ { name, period, values: [ { value, end_time }, ... ] } ] }. */
export function parseMetricValues(body: any): DayValue[] {
  const series = body?.data?.[0]?.values;
  if (!Array.isArray(series)) return [];
  const out: DayValue[] = [];
  for (const v of series) {
    const day = typeof v?.end_time === 'string' ? v.end_time.slice(0, 10) : null;
    const value = typeof v?.value === 'number' ? v.value : null;
    if (day && value != null) out.push({ day, value });
  }
  return out;
}
