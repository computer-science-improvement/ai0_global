import { formatLocalStamp } from '../post/dates';
import type { Passage } from '../post/grounding';

/**
 * Spec 037 FR-004 (T4): the critic's source block. The first 4000 chars of a page are mostly navigation and the
 * lead; the fact the post took is often further down. The critic gets the page title and publication date and the
 * passages around the post's numbers and names (`sourcePassages`, ±400 chars, ≤ 6, ≤ 6000 chars), so it checks each
 * claim against the words it came from — «1 мільйон токенів» next to "context window" is not an output length.
 */
export interface CriticSourceContext {
  url:          string | null;
  /** The page head / library row (no passages: a library item, or nothing of the post is on the page). */
  excerpt:      string | null;
  title?:       string | null;
  /** ISO instant or YYYY-MM-DD; null when the page does not say. */
  publishedAt?: string | null;
  /** Present for a page the run read: the passages (empty = nothing of the post found on the pages read). */
  passages?:    Passage[];
}

export const PASSAGES_CAP = 6_000;

const day = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : null);

/** The lines of the critic prompt's source block after the URL line (a page with passages). */
export function criticPassageLines(s: CriticSourceContext, timezone = 'Europe/Kyiv', headCap = 3_000): string[] {
  const out: string[] = [];
  const when = s.publishedAt ? day(s.publishedAt) ?? formatLocalStamp(s.publishedAt, timezone) : null;
  out.push(`Сторінка: ${s.title ? `«${s.title}»` : 'без заголовка'}; опублікована: ${when ?? 'дата невідома'}.`);
  const passages = s.passages ?? [];
  if (!passages.length) {
    out.push('Чисел і назв поста на прочитаних сторінках не знайдено — кожне число й факт поста неперевірені (grounding).');
    if (s.excerpt) out.push(`Початок сторінки:\n${s.excerpt.slice(0, headCap)}`);
    return out;
  }
  out.push('Уривки навколо чисел і назв поста (±400 знаків, не початок сторінки) — звір із ними кожне число й факт, зокрема що саме число означає:');
  let used = 0;
  passages.forEach((p, i) => {
    if (used >= PASSAGES_CAP) return;
    const text = p.text.slice(0, PASSAGES_CAP - used);
    used += text.length;
    const other = s.url && p.url !== s.url ? ` (інша прочитана сторінка: ${p.url})` : '';
    out.push(`[${i + 1}]${other} про ${p.about.map((a) => `«${a}»`).join(', ')}:\n${text}`);
  });
  return out;
}
