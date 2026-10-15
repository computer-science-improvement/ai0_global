import { addressFindings } from '../../style/style-rules';
import { readerText, type IntegrityCheck } from '../types';

/**
 * Spec 037 FR-008 (T8): `address_mixed` — «ти» and «ви» in one post (error), or a form other than the resource's
 * `style.address` (warning; the owner's default is «ви»). Quoted speech, links and hashtags are not read; the poll
 * question and options are.
 */
export const styleAddressCheck: IntegrityCheck = {
  id: 'style-address',
  codes: ['address_mixed'],
  run: (post, ctx) => addressFindings(readerText(post), ctx.card?.style),
};
