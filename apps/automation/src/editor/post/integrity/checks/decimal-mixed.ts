import { bodyText, type IntegrityCheck } from '../types';

/** «2,5», «73,43%», «1,05T» — a comma decimal (three digits after the comma may be English thousands, so not counted). */
const COMMA_DECIMAL = /(?<![\p{L}\p{N}_/-])(?<!\d[.,])\d+,(?:\d{1,2}|\d{4,})(?!\d|[.,]\d)/gu;
/** «2.0», «$0.10» — a dot decimal; dates (13.10) and versions after a Latin name («Gemini 2.5», «Mellum2.1») are not. */
const DOT_DECIMAL = /(?<![\p{L}\p{N}_/-])(?<!\d[.,])(\d+)\.(\d+)(?!\d|[.,]\d)/gu;
const LATIN_WORD_BEFORE = /\p{Script=Latin}[\p{L}\p{N}+-]*\s+$/u;
const isDate = (a: string, b: string) => Number(a) >= 1 && Number(a) <= 31 && /^(0[1-9]|1[0-2])$/.test(b);

/** The first comma decimal and the first dot decimal of a text, when it has both. */
export function mixedDecimals(text: string): { comma: string; dot: string } | null {
  const comma = COMMA_DECIMAL.exec(text);
  COMMA_DECIMAL.lastIndex = 0;
  if (!comma) return null;
  for (const m of text.matchAll(DOT_DECIMAL)) {
    const at = m.index ?? 0;
    const before = text.slice(Math.max(0, at - 40), at);
    if (LATIN_WORD_BEFORE.test(before)) continue;
    if (isDate(m[1], m[2]) && !/[$€£₴]\s*$/.test(before)) continue;
    return { comma: comma[0], dot: m[0] };
  }
  return null;
}

/**
 * Spec 037 T6: «2,5 млрд» next to «з 2.0 до 47.0» in one post (AI Технології 09.10). Which separator is right is
 * the resource style's call (T8), so only the mix is flagged: a warning.
 */
export const decimalMixedCheck: IntegrityCheck = {
  id: 'decimal-mixed',
  codes: ['decimal_mixed'],
  run: (post) => {
    const m = mixedDecimals(bodyText(post));
    return m ? [{
      code: 'decimal_mixed', level: 'warning' as const,
      message: 'у пості дробові числа і з комою, і з крапкою — пиши всі однаково (в українському тексті — з комою)',
      excerpt: `${m.comma} / ${m.dot}`,
    }] : [];
  },
};
