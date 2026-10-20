import { clip, findingKey } from '../audit-text';
import { AUDIT_LIMITS, type AuditFacts, type Finding } from '../audit.types';

/** Spec 055 FR-001, tools (editor_run_steps of the last 7 days): tools that fail often, roles whose runs do not finish. */

const pct = (n: number, d: number) => Math.round((n / d) * 100);

export function toolErrorFindings(f: AuditFacts): Finding[] {
  return f.toolStats.filter((t) => t.calls >= AUDIT_LIMITS.toolMinCalls && t.errors / t.calls >= AUDIT_LIMITS.toolErrorRate).map((t) => {
    const subject = { type: 'tool' as const, id: t.tool, label: t.tool };
    const top = t.topErrors.slice(0, 3).map((e) => ({ text: clip(e.text, 120), count: e.count }));
    return {
      key: findingKey('tools', 'tool_errors', subject), area: 'tools' as const, check: 'tool_errors', severity: 'warn' as const, subject,
      title: `Tool ${t.tool} fails ${pct(t.errors, t.calls)}% of its calls`,
      detail: `${t.errors} of ${t.calls} calls in ${AUDIT_LIMITS.toolWindowDays} days ended in an error.${top.length ? `\nMost common:\n${top.map((e) => `- ${e.count}× ${e.text}`).join('\n')}` : ''}`,
      evidence: { calls: t.calls, errors: t.errors, rate: Math.round((t.errors / t.calls) * 100) / 100, top },
    };
  });
}

/** Runs of a role that ended `no_terminal` or `max_steps`: the agent talked or looped instead of finishing. */
export function roleFailureFindings(f: AuditFacts): Finding[] {
  return f.roleRuns.filter((r) => r.runs >= AUDIT_LIMITS.roleMinRuns && r.bad / r.runs >= AUDIT_LIMITS.roleBadRate).map((r) => {
    const subject = { type: 'agent' as const, id: `role:${r.role}`, label: `${r.role} role` };
    return {
      key: findingKey('tools', 'role_unfinished', subject), area: 'tools' as const, check: 'role_unfinished', severity: 'warn' as const, subject,
      title: `${pct(r.bad, r.runs)}% of ${r.role} runs end without a result`,
      detail: `${r.bad} of ${r.runs} runs of the ${r.role} role in ${AUDIT_LIMITS.toolWindowDays} days ended as no_terminal or max_steps: the model did not call the tool that finishes the run, or ran out of steps.`,
      evidence: { runs: r.runs, unfinished: r.bad, rate: Math.round((r.bad / r.runs) * 100) / 100 },
    };
  });
}

export const TOOL_CHECKS = [toolErrorFindings, roleFailureFindings];
