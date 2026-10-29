import {
  originWithSource, seriesAbout, seriesSourceConflictAmong, seriesSourceTokens, sourceTokensIn, topicOf, type SeriesSourceConflict, type SeriesSourceFact,
} from '../agents/skill-warnings';
import type { Series } from '../network/playbook';

/**
 * Spec 072 FR-003.1, A2, lead decision I14: does a skill, an owner rule or a steering line send the writer to another source than
 * the one a series is bound to? Pure.
 *
 * The judgement is 073's `seriesSourceConflict` (`agents/skill-warnings.ts`), the same one every skill write runs (lead, 073 × 072
 * merge): a skill the write path accepts is never a doctor blocker, and the reverse. So a text is judged once against every
 * required series it is about, their sources together (W1 integration review): a skill that names each of two series' own
 * sources contradicts neither. `judgePair` is the one place the judge is called.
 */

/** A text that may tell the writer where to take material from. A rule or a steering line has no name or description. */
export interface Candidate {
  kind:         'skill' | 'rule' | 'steering';
  /** Skill id, rule id or `<setId>/<n>`. */
  id:           string;
  name:         string;
  description?: string;
  body:         string;
}

export interface Contradiction {
  series:    Series;
  candidate: Candidate;
  /** The judge that found it: 073's `seriesSourceConflict`. */
  path:      'series_source_conflict';
  /** `other_source`: the text names a source the series does not read; `rules_out_source`: it rules out the one it reads; `original_with_source`: it sets origin=original on what the series reads. */
  kind:      SeriesSourceConflict['reason'];
  /** The tokens that clash. */
  tokens:    string[];
  /** English, for the finding's detail. */
  reason:    string;
  /** The first sentence of the text that carries a clashing token (073's judge names tokens; the owner reads the sentence). */
  sentence:  string | null;
}

/** The series kinds that read a real source: `free`, `network_highlights` and no source have nothing to contradict (A29). */
export const SOURCE_SERIES_KINDS = ['library', 'feed', 'api'] as const;

/** Resolves the `ref` of a `feed` source (a card source id or an address) to the address. Default: the ref as it is. */
export type FeedUrlOf = (ref: string) => string;

/**
 * A series as 073's judge takes it (a feed by its address, so the host label is a token); null for a sourceless series, and for
 * a feed whose ref resolves to no address (an unknown card source id has no host to compare: nothing to judge, as before the merge).
 */
export function seriesSourceFactOf(s: Series, feedUrl: FeedUrlOf = (r) => r): SeriesSourceFact | null {
  const src = s.source;
  if (!src) return null;
  const ref = src.kind === 'library' ? src.table : src.kind === 'api' ? src.source : src.kind === 'feed' ? feedUrl(src.ref) : null;
  if (!ref || (src.kind !== 'library' && src.kind !== 'feed' && src.kind !== 'api')) return null;
  if (src.kind === 'feed' && !sourceTokensIn(ref).length) return null;
  return { series: s.name, kind: src.kind, ref, format: s.format, brief: s.brief };
}

/** The source token of a series (A2): the library table, the host label of the feed, the api name; null when it cannot be told. */
export function seriesSourceToken(s: Series, feedUrl: FeedUrlOf = (r) => r): string | null {
  const src = s.source;
  if (!src) return null;
  switch (src.kind) {
    case 'library': return src.table.toLowerCase();
    case 'api':     return src.source.toLowerCase();
    case 'feed':    return sourceTokensIn(feedUrl(src.ref))[0] ?? null;
    default:        return null;
  }
}

const REASON_TEXT: Record<SeriesSourceConflict['reason'], (tokens: string[]) => string> = {
  other_source:         (t) => `it names ${t.map((x) => `"${x}"`).join(', ')} as a source`,
  rules_out_source:     (t) => `it rules out ${t.map((x) => `"${x}"`).join(', ')}, the source the series reads`,
  original_with_source: () => 'it sets origin=original on the material the series reads',
};

/** The first sentence that names a token as a source, else the first that holds it as a word; at most 160 characters. */
function sentenceOf(body: string, tokens: readonly string[]): string | null {
  const list = body.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const hit = list.find((s) => sourceTokensIn(s).some((t) => tokens.includes(t)))
    ?? list.find((s) => { const low = s.toLowerCase(); return tokens.some((t) => low.includes(t)); });
  return hit ? hit.slice(0, 160) : null;
}

/** A series as the judge takes it, with the fact handed to it. */
interface Judged { s: Series; fact: SeriesSourceFact }

/** The series of `on` a conflict is about: a ruled-out token names its series; another source or origin=original concerns all of them. */
function conflictSeries(k: SeriesSourceConflict, on: readonly Judged[]): Judged[] {
  if (k.reason === 'rules_out_source') {
    const hit = on.filter((j) => seriesSourceTokens(j.fact).some((t) => k.tokens.includes(t)));
    return hit.length ? hit : [...on];
  }
  if (k.reason === 'original_with_source') return on.filter((j) => j.fact.kind === 'library' || j.fact.kind === 'feed');
  return [...on];
}

/**
 * One candidate against the series it is about, in one call of 073's judge per mode:
 * - the required series as the write path judges a skill (`seriesSourceConflict` over the agent's required series: the only one,
 *   else those that share a word with the text), their sources together;
 * - the `suggested` series that share a word with the text (the write path does not judge them), with the required series the
 *   text is about counted as its own sources too.
 * At most one contradiction per series; the first conflict is the verdict. `original_with_source` of a skill whose text
 * `originWithSource` already flags is left to the doctor's own `origin_original_with_source` finding (one finding, said once, as
 * `skillWriteProblems` does for a write).
 */
export function judgePair(series: readonly Series[], c: Candidate, feedUrl: FeedUrlOf = (r) => r): Contradiction[] {
  const judged = series
    .filter((s) => s.active !== false && s.source && (SOURCE_SERIES_KINDS as readonly string[]).includes(s.source.kind))
    .map((s) => ({ s, fact: seriesSourceFactOf(s, feedUrl) }))
    .filter((j): j is Judged => j.fact !== null);
  const required = judged.filter((j) => j.s.source_mode === 'required');
  const opts = { name: c.name, description: c.description ?? '' };
  const aboutFacts = new Set(seriesAbout(c.body, required.map((j) => j.fact), opts));
  const reqAbout = required.filter((j) => aboutFacts.has(j.fact));
  const mine = topicOf(c.name, c.description ?? '', c.body);
  const sugAbout = judged.filter((j) => j.s.source_mode !== 'required' && [...topicOf(j.s.name, j.s.format, j.s.brief)].some((w) => mine.has(w)));

  const said = c.kind === 'skill' && originWithSource(c.body) !== null;
  const verdict = new Map<Series, SeriesSourceConflict>();
  const take = (conflicts: readonly SeriesSourceConflict[], on: readonly Judged[], target: readonly Judged[]) => {
    for (const k of conflicts) {
      if (k.reason === 'original_with_source' && said) continue;
      for (const j of conflictSeries(k, on)) if (target.includes(j) && !verdict.has(j.s)) verdict.set(j.s, k);
    }
  };
  if (reqAbout.length) take(seriesSourceConflictAmong(c.body, reqAbout.map((j) => j.fact)), reqAbout, reqAbout);
  if (sugAbout.length) {
    const on = [...reqAbout, ...sugAbout];
    take(seriesSourceConflictAmong(c.body, on.map((j) => j.fact)), on, sugAbout);
  }
  return judged.filter((j) => verdict.has(j.s)).map(({ s }) => {
    const hit = verdict.get(s)!;
    return {
      series: s, candidate: c, path: 'series_source_conflict', kind: hit.reason, tokens: hit.tokens, reason: REASON_TEXT[hit.reason](hit.tokens),
      sentence: sentenceOf(c.body, hit.tokens),
    };
  });
}

/**
 * Every contradiction between the active series that read a source and the candidates, at most one per (series, candidate)
 * pair, in series order: each candidate is judged once against the series it is about (`judgePair`).
 */
export function seriesSourceContradictions(
  series: readonly Series[], candidates: readonly Candidate[], o: { feedUrl?: FeedUrlOf } = {},
): Contradiction[] {
  const all = candidates.flatMap((c) => judgePair(series, c, o.feedUrl));
  const rank = (x: Contradiction) => series.indexOf(x.series) * (candidates.length + 1) + candidates.indexOf(x.candidate);
  return all.sort((a, b) => rank(a) - rank(b));
}
