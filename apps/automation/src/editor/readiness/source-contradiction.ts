import { skillConflicts, sourceInSkill, sourceTokensIn, topicOf } from '../agents/skill-warnings';
import type { Series } from '../network/playbook';
import { seriesSourceLabel } from '../network/series';

/**
 * Spec 072 FR-003.1, A2, lead decision I14: does a skill, an owner rule or a steering line send the writer to another source than
 * the one a series is bound to? Pure, and built on the helpers of `agents/skill-warnings.ts` (it re-implements none of them).
 *
 * The per-pair judgement is ONE function, `judgePair`: the lead swaps it for 073's `seriesSourceConflict` in one line at the merge.
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
  /** 1: `skillConflicts` (hard or soft); 2: the text names a source of its own for the same topic. */
  path:      'skill_conflicts' | 'source_in_text';
  kind:      'hard' | 'soft' | 'source';
  /** The tokens that clash (path 1) or the sources the text names (path 2). */
  tokens:    string[];
  /** English, for the finding's detail. */
  reason:    string;
  /** Path 2: the sentence that names the source. */
  sentence:  string | null;
}

/** The series kinds that read a real source: `free`, `network_highlights` and no source have nothing to contradict (A29). */
export const SOURCE_SERIES_KINDS = ['library', 'feed', 'api'] as const;

/** Resolves the `ref` of a `feed` source (a card source id or an address) to the address. Default: the ref as it is. */
export type FeedUrlOf = (ref: string) => string;

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

/** «Бери матеріал лише з <label>.» with the feed written as its address, so `skillConflicts` can read the host. */
function seriesBodyOf(s: Series, feedUrl: FeedUrlOf): string {
  const src = s.source!;
  const label = src.kind === 'feed' ? `feed:${feedUrl(src.ref)}` : seriesSourceLabel(src);
  return `Бери матеріал лише з ${label}.`;
}

const head = (t: string) => t.split(/[_-]/)[0];
/** The same source: equal, or the same first part of a key (`nanobanana` for `nanobanana_prompts`). */
const sameSource = (a: string, b: string) => a === b || (head(a).length >= 4 && head(a) === head(b));

/**
 * One series against one candidate. Path 1: `skillConflicts` of the series' own instruction against the candidate finds a hard or
 * a soft conflict. Path 2 (when path 1 finds nothing): `sourceInSkill` finds a source in the text, none of its tokens is the
 * series source, and the series and the text share a topic word. A hit with no tokens («через API») never contradicts.
 */
export function judgePair(series: Series, c: Candidate, feedUrl: FeedUrlOf = (r) => r): Contradiction | null {
  const t = seriesSourceToken(series, feedUrl);
  if (!t || !series.source) return null;
  const seriesBody = seriesBodyOf(series, feedUrl);

  const [conflict] = skillConflicts(seriesBody, [{ name: c.name, description: c.description ?? '', body: c.body }], { name: series.name, description: series.brief, keep: [t] });
  if (conflict) {
    return { series, candidate: c, path: 'skill_conflicts', kind: conflict.kind, tokens: conflict.tokens, reason: conflict.reason, sentence: null };
  }

  const hit = sourceInSkill(c.body);
  if (!hit) return null;
  const tokens = sourceTokensIn(hit.sentence);
  if (!tokens.length || tokens.some((x) => sameSource(x, t))) return null;
  const mine = topicOf(series.name, series.brief, seriesBody);
  const theirs = c.kind === 'skill' ? topicOf(c.name, c.description ?? '', '') : topicOf(c.name, '', c.body);
  const shared = [...theirs].filter((w) => mine.has(w));
  if (!shared.length) return null;
  return {
    series, candidate: c, path: 'source_in_text', kind: 'source', tokens, sentence: hit.sentence,
    reason: `it names ${tokens.map((x) => `"${x}"`).join(', ')} as a source for the same ${shared.slice(0, 2).map((w) => `"${w}"`).join(' / ')}`,
  };
}

/** Every contradiction between the active series that read a source and the candidates, one per (series, candidate) pair. */
export function seriesSourceContradictions(
  series: readonly Series[], candidates: readonly Candidate[], o: { feedUrl?: FeedUrlOf } = {},
): Contradiction[] {
  const out: Contradiction[] = [];
  for (const s of series) {
    if (s.active === false || !s.source || !(SOURCE_SERIES_KINDS as readonly string[]).includes(s.source.kind)) continue;
    for (const c of candidates) {
      const j = judgePair(s, c, o.feedUrl);
      if (j) out.push(j);
    }
  }
  return out;
}
