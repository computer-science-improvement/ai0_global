/**
 * Spec 037 FR-013 (T13): the KPI sample guard. Pure — no I/O. A conclusion about performance ("format X is the
 * strongest") needs a sample big enough to mean something; these thresholds decide when it does.
 *
 *   ok           n ≥ 8 and median ≥ 30 views
 *   insufficient n < 3 or median < 10 views (or no views measured)
 *   low          everything in between
 */

export const KPI_OK_MIN_N = 8;
export const KPI_OK_MIN_MEDIAN_VIEWS = 30;
/** n below this is `insufficient`. */
export const KPI_MIN_N = 3;
/** A median below this is `insufficient`. */
export const KPI_MIN_MEDIAN_VIEWS = 10;
/** The window set_format_weights checks (the get_format_performance default). */
export const KPI_SAMPLE_DAYS = 30;

export type SampleConfidence = 'ok' | 'low' | 'insufficient';

export const INSUFFICIENT_DATA = 'insufficient_data';
export const INSUFFICIENT_DATA_NOTE = 'not enough data to compare formats';
export const CONFIDENCE_RULE = `ok: n ≥ ${KPI_OK_MIN_N} and median ≥ ${KPI_OK_MIN_MEDIAN_VIEWS} views; insufficient: n < ${KPI_MIN_N} or median < ${KPI_MIN_MEDIAN_VIEWS} views; else low`;

/** Confidence of a sample of `n` posts whose median (or mean, where only that exists) is `medianViews`. */
export function sampleConfidence(n: number | null | undefined, medianViews: number | null | undefined): SampleConfidence {
  const count = Number(n ?? 0);
  const median = medianViews == null ? NaN : Number(medianViews);
  if (!Number.isFinite(count) || count < KPI_MIN_N) return 'insufficient';
  if (!Number.isFinite(median) || median < KPI_MIN_MEDIAN_VIEWS) return 'insufficient';
  return count >= KPI_OK_MIN_N && median >= KPI_OK_MIN_MEDIAN_VIEWS ? 'ok' : 'low';
}

/** "n=3, low confidence" / "n=2, insufficient data"; null when ok. */
export function confidenceNote(n: number, c: SampleConfidence): string | null {
  if (c === 'ok') return null;
  return `n=${n}, ${c === 'low' ? 'low confidence' : 'insufficient data'}`;
}

export interface FormatSample {
  format:       string;
  /** Posts with measured views in the window (the sample). */
  n:            number;
  median_views: number | null;
  confidence:   SampleConfidence;
}

/** The top-level summary of get_format_performance: present only when no format can be compared. */
export function formatsSummary(formats: Array<Pick<FormatSample, 'confidence'>>): { summary: typeof INSUFFICIENT_DATA; note: string } | null {
  return formats.every((f) => f.confidence === 'insufficient') ? { summary: INSUFFICIENT_DATA, note: INSUFFICIENT_DATA_NOTE } : null;
}

export interface WeightChange { format: string; from: number; to: number }

/**
 * set_format_weights: a raise or a cut of a format's weight relies on that format's numbers. Refused (with the
 * numbers) when any changed format is `insufficient`; a format without posts in the window counts as n = 0.
 */
export function weightChangeIssue(changes: WeightChange[], samples: FormatSample[], days = KPI_SAMPLE_DAYS) {
  const by = new Map(samples.map((s) => [s.format, s]));
  const weak = changes
    .map((c) => by.get(c.format) ?? { format: c.format, n: 0, median_views: null, confidence: 'insufficient' as const })
    .filter((s) => s.confidence === 'insufficient')
    .map((s) => ({ format: s.format, n: s.n, median_views: s.median_views, confidence: s.confidence }));
  if (!weak.length) return null;
  return {
    error: INSUFFICIENT_DATA,
    details: weak,
    note: `За ${days} днів вибірка цих форматів недостатня (${CONFIDENCE_RULE}) — ваги на таких цифрах не змінюють. Збери більше постів або дій за прямою вказівкою власника.`,
  };
}

/**
 * add_memory: a performance note needs `evidence { n, metric, median_views }`. Returns the problem, or the
 * confidence to store with the note.
 */
export function performanceEvidenceCheck(evidence: Record<string, unknown> | null | undefined):
  | { error: string; details: unknown; note?: string }
  | { confidence: Exclude<SampleConfidence, 'insufficient'>; n: number; median_views: number } {
  const e = evidence ?? {};
  const n = e.n;
  const median = e.median_views;
  const metric = e.metric;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || typeof metric !== 'string' || !metric.trim()
    || typeof median !== 'number' || !Number.isFinite(median)) {
    return {
      error: 'evidence_required',
      details: 'висновок про ефективність потребує evidence { n: кількість постів у вибірці, metric: назва метрики, median_views: медіана переглядів на пост у вибірці }',
    };
  }
  const confidence = sampleConfidence(n, median);
  if (confidence === 'insufficient') {
    return {
      error: INSUFFICIENT_DATA,
      details: { n, metric, median_views: median, confidence },
      note: `Вибірка недостатня (${CONFIDENCE_RULE}) — такий висновок не записують у памʼять.`,
    };
  }
  return { confidence, n, median_views: median };
}

/** A compact KPI metric (kpi-math compactKpis) with the sample marks the digest adds. */
export interface MarkedMetric {
  v: number | null;
  n?: number;
  conf?: Exclude<SampleConfidence, 'ok'>;
  sample?: string;
}

/** The post-based metrics a small weekly sample makes unreliable. */
export const SAMPLE_METRICS = ['views_per_post', 'engagement_rate'] as const;

/**
 * KPI digest: mark the post-based numbers of a resource whose 7-day sample is not `ok`. `posts7d` is the number of
 * posts in the window and `viewsPerPost7d` the mean views per post (the digest has no per-post median).
 * Returns the same object shape with `n`, `conf` and `sample: "(n=3, low confidence)"` on the marked metrics.
 */
export function markSampleConfidence<T extends Record<string, MarkedMetric>>(kpis: T, posts7d: number | null, viewsPerPost7d: number | null): T {
  const n = Math.round(posts7d ?? 0);
  const conf = sampleConfidence(n, viewsPerPost7d);
  if (conf === 'ok') return kpis;
  const out: Record<string, MarkedMetric> = { ...kpis };
  for (const name of SAMPLE_METRICS) {
    const m = out[name];
    if (!m || m.v == null) continue;
    out[name] = { ...m, n, conf, sample: `(${confidenceNote(n, conf)})` };
  }
  return out as T;
}
