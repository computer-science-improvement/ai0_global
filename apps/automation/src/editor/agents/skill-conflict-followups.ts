import type { Agent } from './agent.types';
import type { AgentsRepository } from './agents.repository';
import { MAX_FOLLOW_UPS, type FollowUp } from './pending-actions';
import type { SkillStore } from './skill-store';
import { isProtectedSkill } from '../skills/skill-library';
import { skillConflicts, type SkillConflict } from './skill-warnings';

/**
 * Spec 069 FR-003: the skills a new skill (or a dropped source) contradicts, as `detach_skill` follow-ups for the card.
 * A hard conflict is ticked, a soft one starts unticked (the owner decides). Nothing here writes; a failure to look
 * must never stop the card, so it is returned as `error`.
 */
export interface ConflictDeps {
  agents?: Partial<Pick<AgentsRepository, 'children' | 'get'>>;
  skills?: Partial<Pick<SkillStore, 'listForAgent'>>;
}

/** The follow-up key of "switch this skill off" (an explicit `disable_skills` item and a conflict share it, so they never double). */
export const detachKey = (skill: string): string => `detach:${skill}`;

export interface ConflictFollowUps { then: FollowUp[]; conflicts: SkillConflict[]; error?: string }

/** The orchestrator whose skills are compared: the agent itself, or the parent of a role agent. */
async function rootOf(d: ConflictDeps, a: Agent): Promise<Agent> {
  if (!a.parentId || !d.agents?.get) return a;
  return (await d.agents.get(a.parentId)) ?? a;
}

/**
 * `written` is the skill being written, or, for a dropped source, the owner's words as a negation («не використовуй X»).
 * `appliesTo` (when given) narrows the candidates to skills of an overlapping role. `skip` holds follow-up keys already on
 * the card; `limit` is how many more items the card can take.
 */
export async function conflictFollowUps(
  d: ConflictDeps, agent: Agent,
  written: { name?: string; description?: string; body: string; appliesTo?: readonly string[] },
  o: { skip?: ReadonlySet<string>; limit?: number } = {},
): Promise<ConflictFollowUps> {
  const none: ConflictFollowUps = { then: [], conflicts: [] };
  const limit = Math.max(0, Math.min(o.limit ?? MAX_FOLLOW_UPS, MAX_FOLLOW_UPS));
  if (!d.skills?.listForAgent || !d.agents?.children || limit === 0) return none;
  try {
    const root = await rootOf(d, agent);
    const chain = [root, ...await d.agents.children(root.id)];
    const owners = new Map(chain.map((a) => [a.id, a]));
    const entries = await d.skills.listForAgent(chain.map((a) => a.id));
    const roles = written.appliesTo?.length ? new Set(written.appliesTo) : null;
    const candidates = entries.filter((e) =>
      e.enabled && e.origin !== 'builtin' && !e.skill.safety && !isProtectedSkill(e.skill.name)
      && e.skill.name !== written.name && !o.skip?.has(detachKey(e.skill.name))
      && (!roles || (e.skill.appliesTo ?? []).some((r) => roles.has(r))));
    const conflicts = skillConflicts(written.body, candidates.map((e) => ({ name: e.skill.name, description: e.skill.description, body: e.skill.body ?? '' })),
      { name: written.name, description: written.description }).slice(0, limit);
    const then = conflicts.map((c): FollowUp => {
      const entry = candidates.find((e) => e.skill.name === c.name)!;
      const handle = (entry.skill.agentId ? owners.get(entry.skill.agentId) : null)?.handle ?? root.handle;
      return {
        key: detachKey(c.name), kind: 'detach_skill', payload: { handle, skill: c.name },
        summary: `Disable skill "${c.name}" for @${handle}: ${c.reason}`,
        ...(c.kind === 'soft' ? { ticked: false } : {}),
      };
    });
    return { then, conflicts };
  } catch (err) {
    return { ...none, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The card summary's tail for the conflicts found («Also disables … Suggested (unticked) …»), or ''. */
export function conflictsLine(then: readonly FollowUp[]): string {
  const names = (ticked: boolean) => then.filter((t) => (t.ticked !== false) === ticked).map((t) => `"${String(t.payload.skill)}"`);
  const hard = names(true);
  const soft = names(false);
  return [
    hard.length ? ` Also disables the conflicting skill${hard.length > 1 ? 's' : ''} ${hard.join(', ')}.` : '',
    soft.length ? ` Suggested, unticked: ${soft.join(', ')}.` : '',
  ].join('');
}

/** What the tool tells the model about the conflicts (so it says it to the owner), or {}. */
export function conflictsForModel(found: ConflictFollowUps): Record<string, unknown> {
  if (!found.then.length && !found.error) return {};
  return {
    ...(found.then.length ? {
      conflicts: found.conflicts.map((c) => ({ skill: c.name, kind: c.kind, tokens: c.tokens, why: c.reason })),
      conflicts_note: 'Новий текст суперечить цим скілам. У картці вони стоять наступними кроками: відмічені (hard) вимкнуться разом із застосуванням, невідмічені (soft) — лише якщо власник їх відмітить. Скажи власнику, які саме скіли і чому.',
    } : {}),
    ...(found.error ? { conflicts_error: `конфлікти зі скілами не перевірено: ${found.error}` } : {}),
  };
}
