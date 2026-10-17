import { extractEntities } from '../post/entities';
import { ATTRIBUTION_RE, QUOTE_RE } from '../post/grounding';

/**
 * Spec 041 FR-007 (T7): how much a draft can get wrong in facts, so the critic's model fits the risk. Review 2: the
 * Opus checker earned its cost on posts from an external source with numbers and quotes (a wrong month, a misquote,
 * wrong RAM), not on evergreen and library posts, where language and voice are what fails — the lexicon catches
 * most of that in code.
 *
 *   external source +2 · numbers +1 · quotes / attributed claims +2 · person names +1 · news resource +1
 *   library or evergreen post −1          high: ≥ RISK_HIGH_AT
 */
export const RISK_HIGH_AT = 3;

export type RiskFactor = 'external_source' | 'numbers' | 'quotes' | 'persons' | 'news' | 'library_or_evergreen';
export interface DraftRisk { score: number; level: 'high' | 'low'; factors: RiskFactor[] }

/** A number that is a fact: not a lone ordinal-looking digit in a list marker. */
const NUMBER = /\d[\d\s.,]*\d|\d/u;

export function draftRisk(i: { spec: unknown; text: string; contentKind?: string | null }): DraftRisk {
  const spec = (i.spec ?? {}) as { origin?: string; source?: { url?: string } | null; library_ref?: string; story?: { kind?: string } };
  const factors: RiskFactor[] = [];
  let score = 0;
  const add = (f: RiskFactor, n: number) => { factors.push(f); score += n; };
  if (spec.origin === 'external' || typeof spec.source?.url === 'string') add('external_source', 2);
  const text = i.text.replace(/https?:\/\/\S+/g, ' ');
  if (NUMBER.test(text)) add('numbers', 1);
  if (QUOTE_RE.test(text) || ATTRIBUTION_RE.test(text)) add('quotes', 2);
  if ([...extractEntities(text).entities.values()].some((e) => e.kind === 'person')) add('persons', 1);
  if (i.contentKind === 'news') add('news', 1);
  if (spec.origin === 'library' || !!spec.library_ref || spec.story?.kind === 'evergreen') add('library_or_evergreen', -1);
  return { score, level: score >= RISK_HIGH_AT ? 'high' : 'low', factors };
}
