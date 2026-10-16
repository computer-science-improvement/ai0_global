import type { Agent } from '../agents/agent.types';
import type { SkillStore } from '../agents/skill-store';
import { SkillLibrary } from './skill-library';
import { toneSkillForProfile, type ProfileToneInput } from './skill-defaults';

let repoLib: SkillLibrary | null = null;
const toneNames = (): string[] => { repoLib ??= new SkillLibrary(); return repoLib.all().map((s) => s.name); };

export interface ProfileToneDeps {
  skills:     Pick<SkillStore, 'attachSharedIfUnset'>;
  /** The tone skills that exist (the repo files by default). */
  available?: () => string[];
}

/**
 * Spec 040 FR-012: the resource profile's tone attaches the matching `tone-*` skill to the resource's agent (on, inline),
 * unless the owner already set that skill on the skills tab. Never throws.
 */
export async function attachProfileTone(d: ProfileToneDeps, agent: Pick<Agent, 'id'>, profile: ProfileToneInput | null | undefined): Promise<string | null> {
  const name = toneSkillForProfile(profile, (d.available ?? toneNames)());
  if (!name) return null;
  const r = await d.skills.attachSharedIfUnset(agent.id, name).catch(() => 'missing' as const);
  return r === 'attached' ? name : null;
}
