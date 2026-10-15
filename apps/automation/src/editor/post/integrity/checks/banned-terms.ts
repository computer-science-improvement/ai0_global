import { bannedTermContext, findBannedTerms, normalizeSlop } from '../../slop-phrases';
import { readerText, type IntegrityCheck } from '../types';

/** The owner's banned terms of the card (card.bannedTerms), as in lintPost; nothing without a card. */
export const bannedTermsCheck: IntegrityCheck = {
  id: 'banned-terms',
  codes: ['banned_term'],
  run: (post, ctx) => {
    const text = readerText(post);
    return findBannedTerms(text, ctx.card?.bannedTerms ?? []).map((term) => {
      const word = bannedTermContext(text, term);
      return {
        code: 'banned_term', level: 'error' as const,
        message: `заборонене слово з картки каналу: "${term}"${word && word !== normalizeSlop(term) ? ` (знайдено в «${word}»)` : ''}`,
        excerpt: word ?? term,
      };
    });
  },
};
