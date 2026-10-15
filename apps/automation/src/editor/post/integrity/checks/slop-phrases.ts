import { findSlopPhrases } from '../../slop-phrases';
import { excerptOf, readerText, type IntegrityCheck } from '../types';

/** Spec 034 FR-003 adapter: a listed AI phrase anywhere the reader reads (text, poll) is an error, as in lintPost. */
export const slopPhrasesCheck: IntegrityCheck = {
  id: 'slop-phrases',
  codes: ['banned_term'],
  run: (post) => findSlopPhrases(readerText(post)).map((phrase) => ({
    code: 'banned_term', level: 'error' as const, message: `заборонена фраза: "${phrase}"`, excerpt: excerptOf(phrase),
  })),
};
