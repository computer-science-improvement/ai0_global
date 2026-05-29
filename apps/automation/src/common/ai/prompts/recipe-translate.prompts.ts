import { buildPrompt, BuiltPrompt } from '../prompt-builder';
import { HUMAN_VOICE_SKILL }       from '../skills/human-voice.skill';
import { ANTI_SLOP_SKILL }         from '../skills/anti-slop.skill';
import { RECIPES_CHANNEL_SKILL }   from '../skills/recipes-channel.skill';

export interface RecipeTranslateInput {
  title:        string;
  category:     string | null;
  ingredients:  string | null;
  instructions: string | null;
}

const RECIPE_TRANSLATE_BASE = `ROLE: You localize an English recipe into natural Ukrainian for a home-cooking Telegram channel.

OUTPUT: a single JSON object, nothing else:
{"title_uk": "...", "ingredients_uk": "...", "instructions_uk": "..."}

RULES:
• title_uk — the dish name in natural Ukrainian (keep a well-known original in parentheses if helpful).
• ingredients_uk — one ingredient per line as "<назва> — <кількість>"; convert units naturally (kg→кг, g→г, ml→мл, units→шт.). Preserve the order and count of the source.
• instructions_uk — the numbered steps in Ukrainian, faithful to the source, natural imperative voice. Keep the same numbering.
• Use ONLY the provided data. No new ingredients, no invented steps.
• Ukrainian only for values. No HTML, no emojis, no markdown fences.
• If the recipe is unusable or empty, return exactly: SKIP_POST`;

const SKILLS = [HUMAN_VOICE_SKILL, ANTI_SLOP_SKILL, RECIPES_CHANNEL_SKILL];

export const RECIPE_TRANSLATE_PROMPT: BuiltPrompt = buildPrompt(RECIPE_TRANSLATE_BASE, SKILLS);

export function buildRecipeTranslateUserMessage(input: RecipeTranslateInput): string {
  return [
    `TITLE: ${input.title}`,
    `CUISINE: ${input.category ?? '-'}`,
    `INGREDIENTS:\n${input.ingredients ?? '-'}`,
    `INSTRUCTIONS:\n${input.instructions ?? '-'}`,
  ].join('\n\n');
}
