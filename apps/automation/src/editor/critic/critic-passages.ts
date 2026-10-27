import { formatLocalStamp } from '../post/dates';
import { findInSource, groundNumbers, type GroundingSource, type Passage } from '../post/grounding';
import type { ReadSpan, SourceCoverage } from './read-capture';

/**
 * Spec 037 FR-004 (T4): the critic's source block. The first 4000 chars of a page are mostly navigation and the
 * lead; the fact the post took is often further down. The critic gets the page title and publication date and the
 * passages around the post's numbers and names (`sourcePassages`, ±400 chars; spec 041: ≤ 8 passages, ≤ 8000 chars, claims without numbers too), so it checks each
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
  /** Spec 067 FR-001: how much of the cited source the author read (absent = unknown, as before). */
  coverage?:    SourceCoverage;
  /** `full`: the whole cited page; the critic is told that what is not in it is not in the source. */
  page?:        string;
  /** `read`: what the author read of a big document — all of it (`spans`, with offsets) or, over the display cap, only `size` / `chars` and the passages. */
  read?:        { size: number; chars: number; spans?: ReadSpan[] };
  /**
   * The library row behind the post's `library_ref`, a source of its own next to the cited page: its whole text when it was
   * not clipped, else (`clipped`) the passages around the post's claims and, when there are none, the start of the row.
   */
  library?:     { text?: string; clipped?: boolean; passages?: Passage[]; head?: string };
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
    out.push(`Не знайдено в жодному прочитаному тексті: ${g.missing.slice(0, GROUNDING_MAX).map((m) => `«${m}»`).join(', ')} — це підказка коду, а не доказ: джерело могло записати число словами («over a billion» = «$1 млрд», «Senate Bill 53» = «SB 53»). Звір із уривками; відсутність підтверджуй цитатою уривка.`);
  }
  return out;
}


/** Spec 041 FR-006: as many chars as the passages may have (PASSAGE.chars). */
export const PASSAGES_CAP = 8_000;

const day = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : null);

/** Spec 067 FR-001: the most of a big document's read parts the critic is shown whole (over it: passages around the claims). */
export const READ_DISPLAY_CAP = 12_000;

/** The numbered passages (a page's own, then other pages', labelled) within PASSAGES_CAP chars. */
function passageEntries(s: CriticSourceContext, from = 0): string[] {
  const out: string[] = [];
  let used = 0;
  (s.passages ?? []).forEach((p, i) => {
    if (used >= PASSAGES_CAP) return;
    const text = p.text.slice(0, PASSAGES_CAP - used);
    used += text.length;
    const other = s.url && p.url !== s.url ? ` (інша прочитана сторінка: ${p.url})` : '';
    out.push(`[${from + i + 1}]${other} про ${p.about.map((a) => `«${a}»`).join(', ')}:\n${text}`);
  });
  return out;
}

/** The library row as a source of its own («рядок бібліотеки»): whole, or its passages, or its start. */
function libraryLines(lib: NonNullable<CriticSourceContext['library']>): string[] {
  if (lib.text && !lib.clipped) return ['', 'Рядок бібліотеки (library_ref) — друге джерело поста. Це весь рядок (усі поля): чого тут немає — немає в рядку.', lib.text];
  const out = ['', 'Рядок бібліотеки (library_ref) — друге джерело поста; він довгий, тут лише його частина.'];
  const passages = lib.passages ?? [];
  if (passages.length) {
    let used = 0;
    passages.forEach((p, i) => {
      if (used >= PASSAGES_CAP) return;
      const text = p.text.slice(0, PASSAGES_CAP - used);
      used += text.length;
      out.push(`[р${i + 1}] про ${p.about.map((a) => `«${a}»`).join(', ')}:\n${text}`);
    });
  } else {
    out.push('Чисел і назв поста у цій частині рядка не знайдено.', ...(lib.head ? [`Початок рядка:\n${lib.head}`] : []));
  }
  return out;
}

/**
 * The lines of the critic prompt's source block after the URL line (a page the run read). The block follows what is
 * present (`page`, `read`, `library`), not the stored coverage: that is the lowest among the sources and may be lower
 * than what one of them shows (a whole page next to a clipped library row).
 */
export function criticPassageLines(s: CriticSourceContext, timezone = 'Europe/Kyiv', headCap = 3_000): string[] {
  const out: string[] = [];
  const when = s.publishedAt ? day(s.publishedAt) ?? formatLocalStamp(s.publishedAt, timezone) : null;
  out.push(`Сторінка: ${s.title ? `«${s.title}»` : 'без заголовка'}; опублікована: ${when ?? 'дата невідома'}.`);
  const passages = s.passages ?? [];
  const library = s.library ? libraryLines(s.library) : [];
  // Spec 067 FR-001: a short page (or a document up to 12k) comes whole; what is not on it is not in the source.
  if (s.page) {
    out.push(s.library ? 'Це весь текст цитованої сторінки: чого тут немає — немає на сторінці (рядок бібліотеки — окреме джерело нижче).' : 'Це весь текст сторінки: чого тут немає — немає в джерелі.', s.page);
    if (passages.length) {
      out.push('Уривки з інших сторінок, які прочитав автор (±400 знаків) — факт з іншої сторінки теж є в джерелах:', ...passageEntries(s));
    }
    out.push(...library);
    return out;
  }
  // Spec 067 FR-001: of a big document only what the author read; the rest of it may hold the fact.
  if (s.read) {
    const of = `${s.read.chars} з ${s.read.size} знаків`;
    const note = 'Чого тут немає, автор не читав — це не доказ, що факту немає в джерелі: став grounding 3 з приміткою, не ≤ 2. Підстава для ≤ 2 — лише число, якого немає у цих частинах і яке код не знайшов у жодному прочитаному тексті.';
    if (s.read.spans) {
      out.push(`Що автор прочитав у документі (${of}); перед кожною частиною — її місце в документі:`);
      for (const sp of s.read.spans) out.push(`[знаки ${sp.from}–${sp.to}]\n${sp.text}`);
      if (passages.length) out.push('Уривки з інших сторінок, які прочитав автор (±400 знаків):', ...passageEntries(s));
    } else if (passages.length) {
      out.push(`Що автор прочитав у документі (${of}); ось уривки навколо чисел і назв поста (±400 знаків) — звір із ними кожне число й факт, зокрема що саме число означає:`, ...passageEntries(s));
    } else {
      out.push(`Що автор прочитав у документі (${of}). Чисел і назв поста у прочитаному не знайдено — кожне число й факт поста неперевірені (grounding).`);
      if (s.excerpt) out.push(`Початок прочитаного:\n${s.excerpt.slice(0, headCap)}`);
    }
    out.push(note, ...library);
    return out;
  }
  if (!passages.length) {
    out.push('Чисел і назв поста на прочитаних сторінках не знайдено — кожне число й факт поста неперевірені (grounding).');
    if (s.excerpt) out.push(`Початок сторінки:\n${s.excerpt.slice(0, headCap)}`);
    out.push(...library);
    return out;
  }
  out.push('Уривки навколо чисел і назв поста (±400 знаків, не початок сторінки) — звір із ними кожне число й факт, зокрема що саме число означає:');
  out.push(...passageEntries(s), ...library);
  return out;
}
