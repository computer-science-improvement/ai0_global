import type { AuditSeverity, Finding } from '../sysadmin/audit.types';
import { DOCTOR_CHECKS, type DoctorCheck } from './checks';
import type { ChannelFacts } from './facts.types';

/**
 * Spec 072 FR-003: the channel doctor. Runs every check over the facts, drops a finding whose key it has already seen and sorts
 * error, then warn, then info, then by reason code (and by subject and key, so the same facts always give the same list).
 * No I/O, no model call, no clock: `facts.now` is the only time.
 */
const RANK: Record<AuditSeverity, number> = { error: 0, warn: 1, info: 2 };

export function channelDoctor(facts: ChannelFacts, checks: readonly DoctorCheck[] = DOCTOR_CHECKS): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const check of checks) {
    for (const x of check.run(facts)) {
      if (seen.has(x.key)) continue;
      seen.add(x.key);
      out.push(x);
    }
  }
  return out.sort((a, b) =>
    RANK[a.severity] - RANK[b.severity]
    || (a.check < b.check ? -1 : a.check > b.check ? 1 : 0)
    || (a.subject.id < b.subject.id ? -1 : a.subject.id > b.subject.id ? 1 : 0)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
