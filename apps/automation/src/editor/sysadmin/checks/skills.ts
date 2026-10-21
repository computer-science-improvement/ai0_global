import { lintSkill } from '../../agents/skill-lint';
import { isProtectedSkill } from '../../skills/skill-library';
import { unknownToolRefs, WORKFLOW_SKILLS } from '../../skills/skills-audit';
import { findingKey, jaccard, tokenSet } from '../audit-text';
import { AUDIT_LIMITS, type AgentSkillFact, type AuditFacts, type Finding, type FindingSubject } from '../audit.types';

/** Spec 055 FR-001, skills: lint, unknown tools, never loaded, near-identical bodies, repeated rollbacks. */

const skillSubject = (name: string, id: string, agent: string | null): FindingSubject => ({
  type: 'skill', id, label: name, ...(agent ? { agent } : {}),
});

/** Skills the code puts in a prompt itself, or that guard every post: never "unused". */
const alwaysInPrompt = (s: Pick<AgentSkillFact, 'name' | 'safety'>) => s.safety || isProtectedSkill(s.name) || WORKFLOW_SKILLS.test(s.name);

export function skillLintFindings(f: AuditFacts): Finding[] {
  const out: Finding[] = [];
  for (const s of f.skills) {
    const r = lintSkill({ name: s.name, description: s.description, appliesTo: s.appliesTo, body: s.body });
    if (!r.errors.length && !r.warnings.length) continue;
    const subject = skillSubject(s.name, s.id, s.agent);
    out.push({
      key: findingKey('skills', 'skill_lint', subject), area: 'skills', check: 'skill_lint',
      severity: r.errors.length ? 'error' : 'warn', subject,
      title: `Skill «${s.name}» fails the skill lint`,
      detail: [...r.errors.map((e) => `error ${e.code}: ${e.message}`), ...r.warnings.map((w) => `warning ${w.code}: ${w.message}`)].join('\n'),
      evidence: { scope: s.scope, errors: r.errors.map((e) => e.code), warnings: r.warnings.map((w) => w.code) },
    });
  }
  return out;
}

export function skillUnknownToolFindings(f: AuditFacts): Finding[] {
  if (!f.knownTools.size) return [];
  const out: Finding[] = [];
  for (const s of f.skills) {
    const unknown = unknownToolRefs(`${s.description}\n${s.body}`, f.knownTools);
    if (!unknown.length) continue;
    const subject = skillSubject(s.name, s.id, s.agent);
    out.push({
      key: findingKey('skills', 'skill_unknown_tool', subject), area: 'skills', check: 'skill_unknown_tool', severity: 'warn', subject,
      title: `Skill «${s.name}» names ${unknown.length === 1 ? 'a tool' : 'tools'} that do not exist`,
      detail: `The text refers to ${unknown.map((t) => `\`${t}\``).join(', ')}; no such tool is registered, so an agent that follows the skill fails.`,
      evidence: { unknown },
    });
  }
  return out;
}

/** Enabled, on-demand skills no run of the agent loaded in the window, for an agent that ran often enough. */
export function skillUnusedFindings(f: AuditFacts): Finding[] {
  const out: Finding[] = [];
  for (const a of f.agents) {
    if (a.runs < AUDIT_LIMITS.unusedMinRuns) continue;
    for (const s of a.skills) {
      if (!s.enabled || s.inline || alwaysInPrompt(s)) continue;
      // A skill that applies to no role this agent ran in is never listed in its prompts: nothing to load.
      if (!s.appliesTo.some((r) => a.roles.includes(r))) continue;
      if ((a.loads[s.name] ?? 0) > 0) continue;
      const subject = skillSubject(s.name, s.skillId, a.handle);
      out.push({
        key: findingKey('skills', 'skill_unused', subject), area: 'skills', check: 'skill_unused', severity: 'info', subject,
        title: `Skill «${s.name}» was never loaded by @${a.handle}`,
        detail: `Enabled on demand, but in ${AUDIT_LIMITS.unusedDays} days @${a.handle} (and its role agents) ran ${a.runs} times without loading it. Disabling it shortens the skill list in every prompt.`,
        evidence: { runs: a.runs, days: AUDIT_LIMITS.unusedDays, origin: s.origin },
        fix: { kind: 'skill_disable', agent: a.handle, skill: s.name },
      });
    }
  }
  return out;
}

/** Two enabled skills of one agent with near-identical bodies; the newer one can be disabled. */
export function skillDuplicateFindings(f: AuditFacts): Finding[] {
  const out: Finding[] = [];
  const sets = new Map<string, Set<string>>();
  const setOf = (s: AgentSkillFact) => {
    let t = sets.get(s.skillId);
    if (!t) { t = tokenSet(s.body); sets.set(s.skillId, t); }
    return t;
  };
  const seenShared = new Set<string>();
  for (const a of f.agents) {
    const live = a.skills.filter((s) => s.enabled && !s.safety && !isProtectedSkill(s.name) && setOf(s).size >= AUDIT_LIMITS.duplicateMinTokens);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const x = live[i];
        const y = live[j];
        const sim = jaccard(setOf(x), setOf(y));
        if (sim < AUDIT_LIMITS.skillDuplicateSim) continue;
        const [older, newer] = x.updatedAt.getTime() <= y.updatedAt.getTime() ? [x, y] : [y, x];
        const shared = x.origin !== 'own' && x.origin !== 'override' && y.origin !== 'own' && y.origin !== 'override';
        // Two shared skills look the same to every agent: say it once, without a per-agent fix.
        if (shared) {
          const pair = [x.skillId, y.skillId].sort().join('|');
          if (seenShared.has(pair)) continue;
          seenShared.add(pair);
        }
        const subject = skillSubject(newer.name, newer.skillId, shared ? null : a.handle);
        out.push({
          key: findingKey('skills', 'skill_duplicate', { ...subject, id: `${newer.skillId}~${older.skillId}` }), area: 'skills', check: 'skill_duplicate',
          severity: 'warn', subject,
          title: `Skills «${newer.name}» and «${older.name}» say almost the same`,
          detail: `${Math.round(sim * 100)}% of their words are shared${shared ? ' (both are shared skills)' : ` on @${a.handle}`}. Both are in the agent's context; one is enough.`,
          evidence: { similarity: Math.round(sim * 100) / 100, newer: newer.name, older: older.name },
          ...(shared ? {} : { fix: { kind: 'skill_disable' as const, agent: a.handle, skill: newer.name } }),
        });
      }
    }
  }
  return out;
}

export function skillRollbackFindings(f: AuditFacts): Finding[] {
  return f.rollbacks.filter((r) => r.count >= AUDIT_LIMITS.rollbackCount).map((r) => {
    const subject = skillSubject(r.name, r.skillId, r.agent);
    return {
      key: findingKey('skills', 'skill_rollbacks', subject), area: 'skills' as const, check: 'skill_rollbacks', severity: 'info' as const, subject,
      title: `Skill «${r.name}» was rolled back ${r.count} times`,
      detail: `Edits of this skill were undone ${r.count} times in ${AUDIT_LIMITS.rollbackDays} days: agents keep changing it and the effect keeps failing. Consider locking it or rewriting it by hand.`,
      evidence: { rollbacks: r.count, days: AUDIT_LIMITS.rollbackDays },
    };
  });
}

/** Spec 059: a self-edit that has waited for its probe longer than the probe's own schedule explains. */
export function skillProbeStuckFindings(f: AuditFacts): Finding[] {
  return f.probes.stuck.map((p) => {
    const subject = skillSubject(p.name, p.skillId, p.agent);
    const days = Math.max(AUDIT_LIMITS.probeStuckDays, Math.floor((f.now.getTime() - p.since.getTime()) / 86_400_000));
    return {
      key: findingKey('skills', 'skill_probe_stuck', { ...subject, id: `${p.skillId}@v${p.version}` }), area: 'skills' as const, check: 'skill_probe_stuck', severity: 'warn' as const, subject,
      title: `Edit of skill «${p.name}» (v${p.version}) has waited ${days} days for its probe`,
      detail: `The edit is not live: the previous text is still what the agent reads. The probe runs every hour within SKILL_PROBE_PER_DAY, so a wait this long means the probe is not reaching it — check the daily limit and budget in Settings, that the editor is enabled and a model key is set, and the "SkillProbe" lines in the logs. Until it is decided the edit changes nothing.`,
      evidence: { version: p.version, since: p.since.toISOString(), days_limit: AUDIT_LIMITS.probeStuckDays },
    };
  });
}

/** Spec 059: an agent whose skill edits the probe keeps rejecting. */
export function skillProbeRejectFindings(f: AuditFacts): Finding[] {
  return f.probes.rejects.filter((r) => r.count >= AUDIT_LIMITS.probeRejectCount).map((r) => {
    const subject: FindingSubject = { type: 'agent', id: r.agent, label: `@${r.agent}`, agent: r.agent };
    return {
      key: findingKey('skills', 'skill_probe_rejects', subject), area: 'skills' as const, check: 'skill_probe_rejects', severity: 'info' as const, subject,
      title: `@${r.agent}'s skill edits keep failing the probe`,
      detail: `The probe rejected ${r.count} edits of @${r.agent}'s skills in ${AUDIT_LIMITS.probeRejectDays} days (${r.skills.map((s) => `«${s}»`).join(', ')}): the agent keeps proposing changes that make its posts worse. Self-edits keep failing — consider locking its skills.`,
      evidence: { rejected: r.count, days: AUDIT_LIMITS.probeRejectDays, skills: r.skills },
    };
  });
}

export const SKILL_CHECKS = [skillLintFindings, skillUnknownToolFindings, skillUnusedFindings, skillDuplicateFindings, skillRollbackFindings, skillProbeStuckFindings, skillProbeRejectFindings];
