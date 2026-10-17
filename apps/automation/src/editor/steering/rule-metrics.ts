import { EMOJI_RE, HASHTAG_RE } from '../setup/setup-metrics';
import { hasPostText } from '../setup/setup-posts.types';

/**
 * Spec 041 FR-008 (T8): a steering rule that states a count — emoji, hashtags, length — is checked against what the
 * reference posts actually do. Review 2 accepted «2–3 емодзі в кожному пості» from a reference whose posts had none
 * (the medians counted media posts without text as zero-length, zero-emoji posts). Only posts with text count; a rule
 * whose range does not meet the observed range is refused (`rule_contradicts_metrics`) with the observed values.
 */

export type RuleMetric = 'emoji' | 'hashtags' | 'chars' | 'words';

export interface MetricContradiction {
  code:     'rule_contradicts_metrics';
  metric:   RuleMetric;
  /** What the rule asks for. */
  rule:     { min: number; max: number };
  /** What the reference's posts with text do. */
  observed: { min: number; max: number; median: number; posts: number };
}

const METRIC_RES: Array<[RuleMetric, RegExp]> = [
  ['emoji', /емодз|емоджі|смайл|emoji/iu],
  ['hashtags', /хештег|хэштег|hashtag/iu],
  ['words', /(?<![\p{L}])слів(?![\p{L}])|(?<![\p{L}])слова(?![\p{L}])|words/iu],
  ['chars', /символ|знак(?:ів|и)(?![\p{L}])|characters|chars/iu],
];

const NUM = '(\\d{1,5})';
/** «3–5», «від 2 до 4», «до 300», «не більше 2», «щонайменше 1», «2». */
function ruleRange(text: string): { min: number; max: number } | null {
  let m = new RegExp(`${NUM}\\s*(?:[–—-]|до)\\s*${NUM}`, 'u').exec(text);
  if (m) return { min: Number(m[1]), max: Number(m[2]) };
  m = new RegExp(`(?:до|не\\s+більше|максимум|щонайбільше|max|up\\s+to|at\\s+most)\\s+${NUM}`, 'iu').exec(text);
  if (m) return { min: 0, max: Number(m[1]) };
  m = new RegExp(`(?:від|щонайменше|мінімум|не\\s+менше|at\\s+least|min)\\s+${NUM}`, 'iu').exec(text);
  if (m) return { min: Number(m[1]), max: Number.POSITIVE_INFINITY };
  m = new RegExp(`(?<![\\d.,])${NUM}(?![\\d.,%])`, 'u').exec(text);
  return m ? { min: Number(m[1]), max: Number(m[1]) } : null;
}

const countOf = (metric: RuleMetric, text: string): number => metric === 'emoji' ? (text.match(EMOJI_RE) ?? []).length
  : metric === 'hashtags' ? [...text.matchAll(HASHTAG_RE)].length
    : metric === 'words' ? text.split(/\s+/).filter(Boolean).length
      : text.length;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** The contradiction of one rule text with the reference posts (null when it states no count or fits). */
export function ruleMetricContradiction(text: string, posts: ReadonlyArray<{ text: string }>): MetricContradiction | null {
  const metric = METRIC_RES.find(([, re]) => re.test(text))?.[0];
  if (!metric) return null;
  const rule = ruleRange(text);
  if (!rule) return null;
  const counts = posts.filter(hasPostText).map((p) => countOf(metric, p.text));
  if (counts.length < 3) return null; // too few posts with text to say what the reference does
  const observed = { min: Math.min(...counts), max: Math.max(...counts), median: median(counts), posts: counts.length };
  // Length is never exact: a rule «до 300 символів» fits posts of 250–320; a count is.
  const slack = metric === 'chars' || metric === 'words' ? 0.15 : 0;
  const lo = observed.min * (1 - slack);
  const hi = observed.max * (1 + slack);
  return rule.max < lo || rule.min > hi ? { code: 'rule_contradicts_metrics', metric, rule, observed } : null;
}

const UK: Record<RuleMetric, string> = { emoji: 'емодзі', hashtags: 'хештегів', chars: 'символів', words: 'слів' };

export function metricContradictionUk(c: MetricContradiction): string {
  const r = c.rule.max === Number.POSITIVE_INFINITY ? `від ${c.rule.min}` : c.rule.min === c.rule.max ? `${c.rule.min}` : `${c.rule.min}–${c.rule.max}`;
  return `rule_contradicts_metrics: правило каже ${r} ${UK[c.metric]}, а в ${c.observed.posts} постах референсу з текстом ${c.observed.min}–${c.observed.max} (медіана ${c.observed.median}) — правило має описувати те, що референс справді робить`;
}

export function metricContradictionEn(c: MetricContradiction): string {
  const r = c.rule.max === Number.POSITIVE_INFINITY ? `at least ${c.rule.min}` : c.rule.min === c.rule.max ? `${c.rule.min}` : `${c.rule.min}–${c.rule.max}`;
  return `The rule asks for ${r} ${c.metric}, but the reference's ${c.observed.posts} posts with text have ${c.observed.min}–${c.observed.max} (median ${c.observed.median}).`;
}
