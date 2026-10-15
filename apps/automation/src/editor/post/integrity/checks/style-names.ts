import { nameFindings } from '../../style/style-rules';
import { readerText, type IntegrityCheck } from '../types';

/**
 * Spec 037 FR-008 (T8): `name_script_mixed` (warning) — a person's name in a script other than `style.names`
 * (uk_translit: no Latin names; original: no transliterated foreign names). No policy, no finding.
 */
export const styleNamesCheck: IntegrityCheck = {
  id: 'style-names',
  codes: ['name_script_mixed'],
  run: (post, ctx) => nameFindings(readerText(post), ctx.card?.style),
};
