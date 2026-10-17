import { LANGUAGE_CODES, languageFindings } from '../../language/lexicon';
import { readerText, type IntegrityCheck } from '../types';

/**
 * Spec 041 FR-001 (T1): the Ukrainian language gate on everything the reader reads — russisms and calques
 * (`language_calque`, error), a suspect case, contested calques and the у/в, і/й alternation (warnings; euphony
 * findings carry the exact replacement code applies after the critic passes). Ukrainian resources only.
 */
export const languageCheck: IntegrityCheck = {
  id: 'language',
  codes: LANGUAGE_CODES,
  run: (post, ctx) => (ctx.card?.language && ctx.card.language !== 'uk' ? [] : languageFindings(readerText(post))),
};
