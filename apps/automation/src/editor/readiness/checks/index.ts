import type { Finding } from '../../sysadmin/audit.types';
import type { ChannelFacts } from '../facts.types';
import { configCheck } from './config';
import { launchCheck } from './launch';
import { materialCheck } from './material';
import { pausesCheck } from './pauses';
import { seriesCheck } from './series';
import { sourceCheck } from './source';
import { sourcesCheck } from './sources';
import { toolsCheck } from './tools';

/**
 * Spec 072 FR-003, L5: the doctor's checks. A check is a pure function of the facts: it reads nothing, writes nothing and takes
 * its time from `facts.now`. `code` names the check (its main reason code; one check may emit several related codes).
 * 075 and 076 append their own check files to the list at the merge (076's `sourcesCheck`: the 076 merge, S8).
 */
export interface DoctorCheck {
  code: string;
  run(f: ChannelFacts): Finding[];
}

export const DOCTOR_CHECKS: DoctorCheck[] = [sourceCheck, seriesCheck, materialCheck, toolsCheck, configCheck, pausesCheck, launchCheck, sourcesCheck];
