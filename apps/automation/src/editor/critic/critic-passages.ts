import { formatLocalStamp } from '../post/dates';
import { findInSource, groundNumbers, type GroundingSource, type Passage } from '../post/grounding';

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
  /** Code's check of the post's numbers and dates against every text the run read (absent = nothing to check). */
  grounding?:   CriticGroundingCheck | null;
}

/**
 * The deterministic grounding (post/grounding.ts) for the critic: a number or date the code found in a source is
 * there, even when written another way («19 жовтня» = "10/19/2026", «262 тисяч» = "262K", «4 центи» = "$0.04") —
 * the critic only checks that it means the same thing. The ones not found are what grounding is about.
 */
export interface CriticGroundingCheck {
  found:   Array<{ text: string; as: string; url: string }>;
  missing: string[];
}

const GROUNDING_MAX = 12;

/** The check of a post against the texts the run read: each found claim with how the source writes it. */
export function groundingCheckOf(postText: string, sources: readonly GroundingSource[], o: { publishedAt?: string; timezone?: string } = {}): CriticGroundingCheck | null {
  const r = groundNumbers(postText, sources, o);
  if (!r.checked || !r.numbers.length) return null;
  const found = r.found.map(({ number, urls }) => {
    const src = sources.find((x) => x.url === urls[0]);
    const span = src?.text ? findInSource(number, src.text)[0] : undefined;
    return { text: number.text, as: span && src?.text ? src.text.slice(span[0], span[1]).replace(/\s+/g, ' ').trim().slice(0, 60) : '', url: urls[0] };
  });
  return { found, missing: r.missing.map((m) => m.text) };
}

/** The lines of the critic prompt's grounding block (empty when the post has no numbers or nothing was read). */
export function criticGroundingLines(g: CriticGroundingCheck | null | undefined): string[] {
  if (!g || (!g.found.length && !g.missing.length)) return [];
  const out = ['', '### Звірка чисел і дат кодом (з усіма прочитаними текстами, не лише з уривками вище)'];
  if (g.found.length) {
    out.push(`Знайдено в джерелі: ${g.found.slice(0, GROUNDING_MAX).map((f) => (f.as && f.as !== f.text ? `«${f.text}» (там: «${f.as}»)` : `«${f.text}»`)).join(', ')}.`,
      'Ці числа й дати є в джерелі, навіть якщо записані інакше (інша мова, формат дати, K/M, центи): не знижуй за них grounding і не пиши, що їх немає у фрагменті. Перевір лише, чи вони означають те саме, що в пості.');
  }
  if (g.missing.length) {
    out.push(`Не знайдено в жодному прочитаному тексті: ${g.missing.slice(0, GROUNDING_MAX).map((m) => `«${m}»`).join(', ')} — їх оцінюй як неперевірені (grounding).`);
  }
  return out;
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
