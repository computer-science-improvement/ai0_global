import { findingKey } from '../audit-text';
import { AUDIT_LIMITS, AUDIT_SEVERITIES, type AuditFacts, type Finding } from '../audit.types';
import { MEMORY_CHECKS } from './memory';
import { PROMPT_CHECKS } from './prompt';
import { RULE_CHECKS } from './rules';
import { SKILL_CHECKS } from './skills';
import { TOOL_CHECKS } from './tools';

export * from './memory';
export * from './prompt';
export * from './rules';
export * from './skills';
export * from './tools';

export const ALL_CHECKS: Array<(f: AuditFacts) => Finding[]> = [...SKILL_CHECKS, ...MEMORY_CHECKS, ...RULE_CHECKS, ...TOOL_CHECKS, ...PROMPT_CHECKS];

const rank = (s: Finding['severity']) => AUDIT_SEVERITIES.indexOf(s);

/**
 * Runs every check. A check that throws is skipped (the report says nothing about it rather than failing the audit).
 * One check never floods the report: past `maxPerCheck` findings the rest become one "more like this" line.
 */
export function runChecks(facts: AuditFacts, checks: Array<(f: AuditFacts) => Finding[]> = ALL_CHECKS): Finding[] {
  const all: Finding[] = [];
  for (const check of checks) {
    let found: Finding[] = [];
    try { found = check(facts); } catch { continue; }
    all.push(...found);
  }
  // The same key twice (a pair seen from two agents) is one finding.
  const unique = [...new Map(all.map((x) => [x.key, x])).values()];
  const byCheck = new Map<string, Finding[]>();
  for (const x of unique) byCheck.set(`${x.area}/${x.check}`, [...(byCheck.get(`${x.area}/${x.check}`) ?? []), x]);
  const out: Finding[] = [];
  for (const group of byCheck.values()) {
    const sorted = [...group].sort((a, b) => rank(b.severity) - rank(a.severity));
    if (sorted.length <= AUDIT_LIMITS.maxPerCheck) { out.push(...sorted); continue; }
    const kept = sorted.slice(0, AUDIT_LIMITS.maxPerCheck);
    const rest = sorted.slice(AUDIT_LIMITS.maxPerCheck);
    const first = kept[0];
    const subject = { type: first.subject.type, id: `${first.check}:more`, label: `${rest.length} more` };
    out.push(...kept, {
      key: findingKey(first.area, `${first.check}_more`, subject), area: first.area, check: `${first.check}_more`, severity: 'info', subject,
      title: `${rest.length} more findings like «${first.title}»`,
      detail: `The report lists the ${AUDIT_LIMITS.maxPerCheck} most serious; ${rest.length} more of the same kind are left out: ${rest.slice(0, 5).map((x) => x.subject.label).join(', ')}${rest.length > 5 ? '…' : ''}.`,
      evidence: { omitted: rest.length, check: first.check },
    });
  }
  return out.sort((a, b) => rank(b.severity) - rank(a.severity) || a.area.localeCompare(b.area) || a.title.localeCompare(b.title));
}

/** Counts by severity, and how many have a fix. */
export function countFindings(findings: Finding[]): { total: number; error: number; warn: number; info: number; fixable: number } {
  const c = { total: findings.length, error: 0, warn: 0, info: 0, fixable: 0 };
  for (const f of findings) { c[f.severity]++; if (f.fix) c.fixable++; }
  return c;
}
