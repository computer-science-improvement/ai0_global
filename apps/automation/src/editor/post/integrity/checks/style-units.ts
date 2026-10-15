import { unitFindings } from '../../style/style-rules';
import { readerText, type IntegrityCheck } from '../types';

/**
 * Spec 037 FR-008 (T8): `units_latin` (warning) — with `style.units = words`, «3B», «270M», «49B» instead of
 * «3 млрд», «270 млн»; model names (d1-3B, Qwen3.8-27B, Saluki 27B) stay.
 */
export const styleUnitsCheck: IntegrityCheck = {
  id: 'style-units',
  codes: ['units_latin'],
  run: (post, ctx) => unitFindings(readerText(post), ctx.card?.style),
};
