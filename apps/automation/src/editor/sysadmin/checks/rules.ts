import { clip, findingKey } from '../audit-text';
import type { AuditFacts, Finding } from '../audit.types';

/** Spec 055 FR-001, rules: owner-rule lint, rules vs config, playbooks, steering sets. */

/**
 * Every active owner rule the lint flags (an unknown skill named, a pointer with no content, a request that asks the agent
 * to save or update something). Spec 064 FR-009: the fix retires the row, the owner's click on the report; the text of a
 * good rule can be written again afterwards (the finding links to the Rules artifact).
 */
export function ruleLintFindings(f: AuditFacts): Finding[] {
  return f.rules.filter((r) => r.issues.length).map((r) => {
    const subject = { type: 'rule' as const, id: `${r.channel}#${r.id}`, label: clip(r.text, 80), channel: r.channel, ...(r.agent ? { agent: r.agent } : {}) };
    return {
      key: findingKey('rules', 'rule_lint', subject), area: 'rules' as const, check: 'rule_lint', severity: 'warn' as const, subject,
      title: `${r.channel}: your rule #${r.id} does not work as a rule`,
      detail: `«${clip(r.text, 200)}»\n${r.issues.map((i) => `${i.code}: ${i.detail}`).join('\n')}\nApplying the fix retires this rule; add a corrected one if the idea still matters.`,
      evidence: { codes: r.issues.map((i) => i.code), ruleId: r.id },
      fix: { kind: 'memory_retire' as const, channel: r.channel, id: r.id },
    };
  });
}

/** Where an orchestrator's playbook or profiles contradict the owner's rules; one finding per agent, fixed by the resolver card's apply. */
export function configConflictFindings(f: AuditFacts): Finding[] {
  return f.conflicts.filter((c) => c.conflicts.length).map((c) => {
    const subject = { type: 'agent' as const, id: c.agent, label: `@${c.agent}`, agent: c.agent, ...(c.channel ? { channel: c.channel } : {}) };
    return {
      key: findingKey('rules', 'config_conflicts', subject), area: 'rules' as const, check: 'config_conflicts', severity: 'warn' as const, subject,
      title: `@${c.agent}: ${c.conflicts.length} ${c.conflicts.length === 1 ? 'setting contradicts' : 'settings contradict'} your rules`,
      detail: c.conflicts.map((x) => `- ${x.detail}`).join('\n'),
      evidence: { conflicts: c.conflicts.map((x) => ({ code: x.code, ref: x.ref, ruleId: x.ruleId })) },
      fix: { kind: 'conflicts_resolve' as const, agent: c.agent },
    };
  });
}

/** The active playbook of each orchestrator: validation errors are real (it is live), soft warnings are info. */
export function playbookFindings(f: AuditFacts): Finding[] {
  const out: Finding[] = [];
  for (const p of f.playbooks) {
    const subject = { type: 'playbook' as const, id: p.agent, label: `Playbook of @${p.agent}`, agent: p.agent, ...(p.channel ? { channel: p.channel } : {}) };
    if (p.errors.length) {
      out.push({
        key: findingKey('rules', 'playbook_invalid', subject), area: 'rules', check: 'playbook_invalid', severity: 'error', subject,
        title: `@${p.agent}: the active playbook (v${p.version}) fails its own validation`,
        detail: p.errors.slice(0, 8).map((e) => `- ${clip(e, 200)}`).join('\n') + (p.errors.length > 8 ? `\n…and ${p.errors.length - 8} more` : ''),
        evidence: { version: p.version, errors: p.errors.slice(0, 20) },
      });
    }
    if (p.warnings.length) {
      out.push({
        key: findingKey('rules', 'playbook_warnings', subject), area: 'rules', check: 'playbook_warnings', severity: 'info', subject,
        title: `@${p.agent}: the active playbook (v${p.version}) has ${p.warnings.length} soft ${p.warnings.length === 1 ? 'warning' : 'warnings'}`,
        detail: p.warnings.slice(0, 8).map((w) => `- ${clip(w.text, 200)}`).join('\n'),
        evidence: { version: p.version, codes: [...new Set(p.warnings.map((w) => w.code))] },
      });
    }
  }
  return out;
}

/** Active steering sets that give the agent nothing, or whose channel no longer exists. */
export function steeringFindings(f: AuditFacts): Finding[] {
  const out: Finding[] = [];
  for (const s of f.steering) {
    if (s.status !== 'active') continue;
    const subject = { type: 'steering' as const, id: s.id, label: `Steering ${s.source} → ${s.target}`, ...(s.channel ? { channel: s.channel } : {}) };
    if (!s.channelExists) {
      out.push({
        key: findingKey('rules', 'steering_orphan', subject), area: 'rules', check: 'steering_orphan', severity: 'warn', subject,
        title: `Steering for ${s.target} points at a channel that is gone`,
        detail: `The set from ${s.source} is active, but ${s.channel ?? s.target} has no editor card any more, so no agent reads it. Discard the set.`,
        evidence: { target: s.target, source: s.source },
      });
    } else if (s.enabledRules === 0) {
      out.push({
        key: findingKey('rules', 'steering_empty', subject), area: 'rules', check: 'steering_empty', severity: 'warn', subject,
        title: `Steering from ${s.source} is active with no rules`,
        detail: `Every rule of the set for ${s.target} is switched off (or in conflict with your rules), so it shapes nothing. Enable a rule or discard the set.`,
        evidence: { target: s.target, source: s.source },
      });
    }
  }
  return out;
}

export const RULE_CHECKS = [ruleLintFindings, configConflictFindings, playbookFindings, steeringFindings];
