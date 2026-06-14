// Pure helpers: recipes row → CarouselRecipe, and the short post caption.
// No I/O — unit-tested directly.
import { parseNum } from '../../common/carousel/carousel-text';
import type { CarouselRecipe } from '../../common/carousel/recipe-carousel-renderer.service';
import type { RecipeRow } from '../recipes/recipes.repository';

/** Map a recipes row → CarouselRecipe (pg-NUMERIC strings parsed to number|null). */
export function toCarouselRecipe(row: RecipeRow): CarouselRecipe {
  return {
    titleUk:        row.title_uk ?? '',
    category:       row.category,
    kcal:           parseNum(row.kcal),
    proteinG:       parseNum(row.protein_g),
    fatG:           parseNum(row.fat_g),
    carbsG:         parseNum(row.carbs_g),
    ingredientsUk:  row.ingredients_uk ?? '',
    instructionsUk: row.instructions_uk ?? '',
  };
}

/** Compact per-serving macros line, '' when no data. */
export function macrosLine(row: RecipeRow): string {
  const kcal = parseNum(row.kcal);
  const p = parseNum(row.protein_g), f = parseNum(row.fat_g), c = parseNum(row.carbs_g);
  const parts: string[] = [];
  if (kcal != null) parts.push(`🔥 ${Math.round(kcal)} ккал`);
  if (p != null)    parts.push(`Б ${p}`);
  if (f != null)    parts.push(`Ж ${f}`);
  if (c != null)    parts.push(`В ${c}`);
  return parts.length ? `${parts.join(' · ')} (на порцію)` : '';
}

/** Short post caption — the slides carry the detail. Title + cuisine + macros + CTA. */
export function buildCarouselCaption(row: RecipeRow): string {
  const lines: string[] = [row.title_uk ?? ''];
  if (row.category) lines.push(`🍽️ ${row.category}`);
  const macros = macrosLine(row);
  if (macros) lines.push(macros);
  lines.push('Повний рецепт — гортай 👉');
  return lines.filter(Boolean).join('\n\n');
}
