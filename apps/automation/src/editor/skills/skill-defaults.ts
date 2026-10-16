import type { EditorRole } from '../llm/llm.types';
import { isOptionalSkill } from './skill-library';

/**
 * Spec 040 FR-012: owner and agent skills reach the writer. On 10-16 `loko-channel-guide` («головний скіл, на кожному
 * пості») was loaded 0 times: it was only listed (never inline), and 31 of 52 skills were never loaded at all.
 */

/** A channel skill written without `applies_to` is for the post writers: the executor, the chat composer and the critic. */
export const CHANNEL_SKILL_ROLES: readonly EditorRole[] = ['executor', 'composer', 'checker'];

/** Default `applies_to` for a skill written for an agent: channel / network agents get the writer roles; others must say. */
export function defaultAppliesTo(agent: { scope: string }): EditorRole[] | null {
  return agent.scope === 'resource' || agent.scope === 'network' ? [...CHANNEL_SKILL_ROLES] : null;
}

/**
 * Which `tone-*` skill a resource profile asks for: a tone skill named in the tone (or topic), else the one topic
 * family the profile clearly belongs to. Two families (or none) → null: a wrong voice is worse than no tone skill.
 * The news tones (`tone-ai0-news`, `tone-ua-news`) belong to one resource each, so only an explicit name attaches them.
 */
const TONE_FAMILIES: ReadonlyArray<[string, RegExp]> = [
  ['tone-gaming', /(?<![\p{L}])(?:ігр|ігор|гейм|геймер|gaming|games?|steam|роздач)/iu],
  ['tone-movies', /(?<![\p{L}])(?:фільм|серіал|кіно|movie|films?|series|netflix)/iu],
  ['tone-recipes', /(?<![\p{L}])(?:рецепт|кулінар|страв|готуван|recipes?|cooking)/iu],
  ['tone-space', /(?<![\p{L}])(?:космос|космічн|ракет|nasa|spacex|space)/iu],
  ['tone-daily-photo', /(?:фото\s+дня|астрофото|apod|photo\s+of\s+the\s+day)/iu],
  ['tone-on-this-day', /(?:цей\s+день\s+в\s+історії|цього\s+дня|on\s+this\s+day)/iu],
  ['tone-birthday-story', /(?:день\s+народження|біографі|birthday)/iu],
];

export interface ProfileToneInput {
  tone?:         string | null;
  topic?:        string | null;
  format_prefs?: { tone?: string | null } | null;
}

export function toneSkillForProfile(profile: ProfileToneInput | null | undefined, available: readonly string[]): string | null {
  if (!profile) return null;
  const known = new Set(available.filter(isOptionalSkill));
  const text = [profile.tone, profile.format_prefs?.tone, profile.topic].filter(Boolean).join(' \n ');
  if (!text) return null;
  const named = [...text.matchAll(/tone-[a-z0-9-]+/gi)].map((m) => m[0].toLowerCase()).filter((n) => known.has(n));
  if (named.length) return named[0];
  // Photo of the day is about space too: the narrower family wins over tone-space.
  const hits = TONE_FAMILIES.filter(([name, re]) => known.has(name) && re.test(text)).map(([name]) => name);
  const narrowed = hits.includes('tone-daily-photo') ? hits.filter((n) => n !== 'tone-space') : hits;
  return narrowed.length === 1 ? narrowed[0] : null;
}
