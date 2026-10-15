import { glossaryFindings } from '../../style/style-rules';
import { readerText, type IntegrityCheck } from '../types';

/**
 * Spec 037 FR-008 (T8): `glossary_violation` — a form the resource's glossary bans (АПІ, КЛІ, Разом AI, спотифай by
 * default), an error with the right form. Hashtags count, links do not; ШІ / AI is not a glossary rule (owner).
 */
export const styleGlossaryCheck: IntegrityCheck = {
  id: 'style-glossary',
  codes: ['glossary_violation'],
  run: (post, ctx) => glossaryFindings(readerText(post), ctx.card?.style),
};
