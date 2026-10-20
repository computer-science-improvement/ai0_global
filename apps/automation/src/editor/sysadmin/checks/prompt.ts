import { isProtectedSkill } from '../../skills/skill-library';
import { SKILL_MAX_INLINE_BODY } from '../../agents/skill-lint';
import { WORKFLOW_SKILLS } from '../../skills/skills-audit';
import { findingKey } from '../audit-text';
import { AUDIT_LIMITS, type AuditFacts, type Finding } from '../audit.types';

/** Spec 055 FR-001, prompt: an agent whose always-in-context skills do not fit the inline budget (some are silently dropped). */
export function inlineBudgetFindings(f: AuditFacts): Finding[] {
  const out: Finding[] = [];
  for (const a of f.agents) {
    // The prompts inline an enabled skill only when it fits the per-skill limit; that is what takes budget.
    const inline = a.skills.filter((s) => s.enabled && s.inline && s.body.length <= SKILL_MAX_INLINE_BODY);
    const total = inline.reduce((n, s) => n + s.body.length, 0);
    if (total <= AUDIT_LIMITS.inlineBudget) continue;
    const biggest = inline
      .filter((s) => !s.safety && !isProtectedSkill(s.name) && !WORKFLOW_SKILLS.test(s.name))
      .sort((x, y) => y.body.length - x.body.length)[0];
    const subject = { type: 'agent' as const, id: a.handle, label: `@${a.handle}`, agent: a.handle };
    out.push({
      key: findingKey('prompt', 'inline_over_budget', subject), area: 'prompt', check: 'inline_over_budget', severity: 'warn', subject,
      title: `@${a.handle}: always-in-context skills are ${total} characters, over the ${AUDIT_LIMITS.inlineBudget} budget`,
      detail: `${inline.length} skills are kept in context (${inline.map((s) => `${s.name} ${s.body.length}`).join(', ')}). A prompt inlines them in order until the budget is spent, so the last ones are dropped silently.${biggest ? ` Turning «${biggest.name}» to on-demand frees ${biggest.body.length} characters.` : ''}`,
      evidence: { total, budget: AUDIT_LIMITS.inlineBudget, skills: inline.map((s) => ({ name: s.name, chars: s.body.length })) },
      ...(biggest ? { fix: { kind: 'skill_inline_off' as const, agent: a.handle, skill: biggest.name } } : {}),
    });
  }
  return out;
}

export const PROMPT_CHECKS = [inlineBudgetFindings];
