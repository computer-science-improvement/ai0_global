import { Skill } from './skills/skill.interface';

export interface BuiltPrompt {
  system: string;
  /** Skills that were applied, for logging/debugging */
  appliedSkills: string[];
}

/**
 * Composes a base system prompt with one or more skills.
 * Each skill appends its instructions as a clearly labelled section.
 *
 * Usage:
 *   const prompt = buildPrompt(BASE, [ANTI_SLOP_SKILL, TONE_SKILL]);
 *   await agent.chat([{ role: 'system', content: prompt.system }, ...]);
 */
export function buildPrompt(base: string, skills: Skill[] = []): BuiltPrompt {
  const skillBlocks = skills
    .map((s) => s.instructions.trim())
    .join('\n\n');

  const system = skills.length
    ? `${base.trim()}\n\n${skillBlocks}`
    : base.trim();

  return {
    system,
    appliedSkills: skills.map((s) => s.name),
  };
}
