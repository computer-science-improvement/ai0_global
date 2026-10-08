import { SkillLibrary, type Skill, type SkillSource } from '../skills/skill-library';
import type { VoicePrefs } from '../post/slop-lint';

/**
 * Spec 034 FR-001/FR-002: the voice every writer prompt carries.
 *
 * - `voice-core` (≤ 2 500 chars) is inlined for every role that writes reader
 *   text (Telegram, platform and derived executors, the composer) outside the
 *   8k inline budget, so it is never dropped. It is read from the repo file
 *   (the builtin), not from the agent's skill view: a disabled toggle or an
 *   override never removes it.
 * - The resource's humour / slang setting is stated explicitly, defaults off.
 * - The full `human-voice` and `anti-slop` skills are attached from the
 *   remaining budget (they no longer depend on an optional load_skill); what
 *   does not fit gets a one-line reference, and lint enforces the phrase list.
 */
export const VOICE_CORE = 'voice-core';
/** Attached in this order while the budget allows (human-voice ≈ 2.2k, anti-slop ≈ 10.6k chars). */
export const VOICE_SKILLS = ['human-voice', 'anti-slop'] as const;
/** Budget for the attached voice skills in the platform and adapt prompts (they have no 8k inline budget of their own). */
export const VOICE_SKILLS_BUDGET = 4_000;

let repoLib: SkillLibrary | null = null;
function repoSkill(name: string): Skill | undefined {
  repoLib ??= new SkillLibrary();
  return repoLib.get(name);
}

/** Last resort if the skills directory is missing (never in a normal build): the essence in two lines. */
const VOICE_CORE_FALLBACK = [
  'Факти замість прикметників, короткі речення, перше речення — головний факт, останнє — конкретний факт.',
  'Без AI-штампів («варто зазначити», «у сучасному світі», «по суті»), без риторичних питань з відповіддю, без моралі в кінці, максимум один знак оклику.',
].join('\n');

export function voiceCoreBody(skills?: SkillSource | null): string {
  return repoSkill(VOICE_CORE)?.body ?? skills?.get(VOICE_CORE)?.body ?? VOICE_CORE_FALLBACK;
}

/** «Гумор: вимкнено — …; сленг: ні» for the resource the post is written for. */
export function voiceSettingsLine(v?: Pick<VoicePrefs, 'humor' | 'slang'> | null): string {
  const humor = v?.humor === 'light'
    ? 'Гумор: легкий (дозволив власник) — доречна легка іронія без мемів; у новинах про загибель, війну, хвороби й катастрофи — жодного гумору.'
    : 'Гумор: вимкнено — жодних жартів, мемів, гри слів, іронічних підморгувань.';
  const slang = v?.slang === true
    ? 'Сленг: дозволено власником — помірно й лише там, де він природний для аудиторії.'
    : 'Сленг: ні — жива нормативна мова без молодіжного жаргону.';
  return `Налаштування голосу цього ресурсу (format_prefs, змінює лише власник). ${humor} ${slang}`;
}

/** The voice block of a writer prompt: voice-core plus the resource's humour/slang line. */
export function voiceCoreSection(v?: Pick<VoicePrefs, 'humor' | 'slang'> | null, skills?: SkillSource | null): string[] {
  return ['', '## Голос (voice-core, діє завжди)', voiceCoreBody(skills), '', voiceSettingsLine(v)];
}

/**
 * Attach `human-voice` and `anti-slop` in full while `budget` allows (skipping
 * names already inlined). Missing ones come back in `missing` for a reference line.
 */
export function attachVoiceSkills(skills: SkillSource, budget: number, already: readonly string[] = []): { inline: string[]; names: string[]; used: number; missing: string[] } {
  const inline: string[] = [];
  const names: string[] = [];
  const missing: string[] = [];
  let used = 0;
  for (const name of VOICE_SKILLS) {
    if (already.includes(name)) continue;
    const s = skills.get(name) ?? repoSkill(name);
    if (!s) continue;
    if (s.body.length <= budget - used) {
      inline.push(`### skill: ${s.name}\n${s.body}`);
      names.push(s.name);
      used += s.body.length;
    } else {
      missing.push(name);
    }
  }
  return { inline, names, used, missing };
}

/** One line for voice skills that did not fit: what they are and that lint already enforces the bans. */
export function voiceReferenceLine(missing: readonly string[]): string | null {
  if (!missing.length) return null;
  return `Повні правила голосу (${missing.join(', ')}) не вмістилися в контекст: найсильніші заборони вже у voice-core, а заборонені фрази перевіряє lint. Якщо сумніваєшся в тексті — завантаж їх через load_skill.`;
}
