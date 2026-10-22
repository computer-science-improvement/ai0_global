import type { IntegrityCheck } from '../types';
import { textReplacementCharCheck } from './text-replacement-char';
import { mixedScriptWordCheck } from './mixed-script-word';
import { processLeakCheck } from './process-leak';
import { duplicateAttributionCheck } from './duplicate-attribution';
import { leadTooLongCheck } from './lead-too-long';
import { verbatimRepeatCheck } from './verbatim-repeat';
import { decimalMixedCheck } from './decimal-mixed';
import { duplicateSourceLinkCheck } from './duplicate-source-link';

/** Spec 037 T6: the text hygiene checks, in report order (one registry line). The soft slop phrases are in slop-lint.ts. */
export const TEXT_HYGIENE_CHECKS: IntegrityCheck[] = [
  textReplacementCharCheck,
  mixedScriptWordCheck,
  processLeakCheck,
  duplicateAttributionCheck,
  leadTooLongCheck,
  verbatimRepeatCheck,
  decimalMixedCheck,
  // Spec 063 FR-006.
  duplicateSourceLinkCheck,
];
