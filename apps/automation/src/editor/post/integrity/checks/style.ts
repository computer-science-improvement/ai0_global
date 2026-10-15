import type { IntegrityCheck } from '../types';
import { styleAddressCheck } from './style-address';
import { styleGlossaryCheck } from './style-glossary';
import { styleNamesCheck } from './style-names';
import { styleUnitsCheck } from './style-units';
import { styleHashtagsCheck } from './style-hashtags';

/** Spec 037 T8: the resource style sheet checks, registered as one group. */
export const styleChecks: IntegrityCheck[] = [styleAddressCheck, styleGlossaryCheck, styleNamesCheck, styleUnitsCheck, styleHashtagsCheck];
