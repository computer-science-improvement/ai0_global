import { buildPrompt, BuiltPrompt } from '../prompt-builder';
import { HUMAN_VOICE_SKILL }       from '../skills/human-voice.skill';
import { ANTI_SLOP_SKILL }         from '../skills/anti-slop.skill';
import { RECIPES_CHANNEL_SKILL }   from '../skills/recipes-channel.skill';
import { RecipeItem }              from '../../../workflows/recipes/types';

// ─── Base prompt ─────────────────────────────────────────────────────────────

const RECIPE_DESC_BASE = `ROLE: You receive data about a dish and produce two things in Ukrainian:
1. A short description of the dish (2-3 sentences, what it is and what makes it distinctive)
2. A translated list of ingredients

CONSTRAINTS:
• Use ONLY the provided data. No new facts or assumptions.
• Dish description: max 200 characters.
• Ingredients: translate each ingredient to Ukrainian, keep measurements as-is (e.g. "4 нарізаних Морква", "1 ст.л. Коричневий цукор").

FORMAT:
Return a JSON object with exactly two fields, nothing else:
{"description": "...", "ingredients": ["...", "..."]}

• Ukrainian only for values.
• No HTML, no emojis.
• Return ONLY the JSON object.`;

// ─── Assembled prompt (base + skills) ────────────────────────────────────────

const SKILLS = [HUMAN_VOICE_SKILL, ANTI_SLOP_SKILL, RECIPES_CHANNEL_SKILL];

export const RECIPE_PROMPT: BuiltPrompt = buildPrompt(RECIPE_DESC_BASE, SKILLS);

// ─── User message builder ────────────────────────────────────────────────────

export function buildRecipeUserMessage(item: RecipeItem): string {
  const instructionSnippet = item.instructions.slice(0, 200);

  return [
    `TITLE: ${item.title}`,
    `CATEGORY: ${item.category}`,
    `AREA: ${item.area}`,
    `INSTRUCTIONS: ${instructionSnippet}`,
    `INGREDIENTS:\n${item.ingredients.join('\n')}`,
  ].join('\n');
}
