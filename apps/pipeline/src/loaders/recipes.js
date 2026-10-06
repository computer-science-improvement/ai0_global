/**
 * Loader: data/normalized/recipes/recipes.json → the `recipes` dataset (data store, spec 032)
 *
 * recipes.json is gitignored and produced by `pnpm run parse:recipes` (also part
 * of `pnpm run parse`). If it is missing the loader warns and exits 0, so
 * `load:all` / `db:seed` still load every other table.
 *
 * Modes:
 *   default            — insert new recipes; an existing slug is skipped.
 *   LOAD_FRESH=1 / --fresh  (`load:recipes:fresh`)
 *                      — refresh the source columns of existing recipes from the
 *                        dataset (merge on slug, only REFRESH_COLUMNS). Requires ALLOW_TRUNCATE=yes.
 *                        Never touches translations (title_uk, ingredients_uk,
 *                        instructions_uk, translated_at), Telegraph pages
 *                        (telegraph_url/path), post_text or `posted`. It used to
 *                        TRUNCATE the table, which wiped all of those; rows that
 *                        are no longer in the dataset are now kept.
 *
 * LOAD_LIMIT=N — test mode, first N items
 */
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { pool } from '../lib/db.js';
import { loadData, schemaFor, formatLoad } from '../lib/loader.js';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const RECIPES_FILE = join(__dirname, '..', 'data', 'normalized', 'recipes', 'recipes.json');

const limitArg = process.env.LOAD_LIMIT || process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1];
const LIMIT    = limitArg ? parseInt(limitArg, 10) : null;

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
}

/** Fields the loader writes (the dataset's dedup key is slug). */
export const COLUMNS  = ['title', 'slug', 'url', 'description', 'ingredients', 'instructions', 'image_url', 'category', 'tags', 'post_text', 'kcal', 'protein_g', 'fat_g', 'carbs_g', 'serving_size_g', 'raw'];

/** Columns a refresh must never overwrite (state owned by strategies/editor, not the dataset). */
export const PRESERVED_COLUMNS = ['posted', 'post_text', 'title_uk', 'ingredients_uk', 'instructions_uk', 'translated_at', 'telegraph_url', 'telegraph_path'];

/** Source columns a refresh overwrites from the dataset (conflict key excluded). */
export const REFRESH_COLUMNS = COLUMNS.filter((c) => c !== 'slug' && !PRESERVED_COLUMNS.includes(c));

/** Returns a refusal reason, or null when a refresh may proceed. */
export function freshRefusal(env = process.env) {
  if (env.ALLOW_TRUNCATE !== 'yes') {
    return 'set ALLOW_TRUNCATE=yes to confirm overwriting the source columns of existing recipes';
  }
  return null;
}

export function mapRecipe(recipe) {
  return {
    title:        recipe.title,
    slug:         recipe.slug || slugify(recipe.title),
    url:          recipe.url          ?? null,
    description:  recipe.description  ?? null,
    ingredients:  recipe.ingredients  ?? null,
    instructions: recipe.instructions ?? null,
    image_url:    recipe.image_url    ?? recipe.imageUrl ?? null,
    category:     recipe.category     ?? null,
    tags:         Array.isArray(recipe.tags) ? recipe.tags.map(String) : [],
    post_text:    recipe.post_text    ?? recipe.postText ?? null,
    kcal:           recipe.kcal           ?? null,
    protein_g:      recipe.protein_g      ?? null,
    fat_g:          recipe.fat_g          ?? null,
    carbs_g:        recipe.carbs_g        ?? null,
    serving_size_g: recipe.serving_size_g ?? null,
    // Strip NUL escapes — Postgres jsonb (and text) reject . Some source
    // recipes carry a stray null char in free-text fields (e.g. serving tips).
    raw:          recipe.raw ? JSON.parse(JSON.stringify(recipe.raw).replace(/\\u0000/g, '')) : null,
  };
}

async function main() {
  const FRESH = process.env.LOAD_FRESH === '1' || process.argv.includes('--fresh');
  if (FRESH) {
    const refusal = freshRefusal();
    if (refusal) {
      console.error(`Refusing to refresh recipes: ${refusal}.`);
      process.exitCode = 1;
      await pool.end();
      return;
    }
  }

  if (!existsSync(RECIPES_FILE)) {
    console.warn(`No ${RECIPES_FILE} — run \`pnpm run parse:recipes\` first. Skipping recipes.`);
    await pool.end();
    return;
  }

  const raw  = await readFile(RECIPES_FILE, 'utf-8');
  const data = JSON.parse(raw);

  const recipes = data.recipes ?? data;
  if (!Array.isArray(recipes)) {
    console.error('Expected "recipes" array in JSON');
    process.exit(1);
  }

  let rows = recipes.filter((r) => r.title).map(mapRecipe);

  if (LIMIT) {
    console.log(`Test mode: first ${LIMIT} items\n`);
    rows = rows.slice(0, LIMIT);
  }

  if (!rows.length) {
    console.log('No recipes to load');
    await pool.end();
    return;
  }

  if (FRESH) {
    console.log(`Refreshing ${rows.length} recipes (upsert on slug; translations, Telegraph and posted kept)`);
    const r = await loadData(schemaFor('recipes'), rows, { updateFields: REFRESH_COLUMNS, filename: 'recipes/recipes.json (fresh)' });
    console.log(`Recipes — ${formatLoad(r)}`);
  } else {
    console.log(`Loading ${rows.length} recipes`);
    const r = await loadData(schemaFor('recipes'), rows, { filename: 'recipes/recipes.json' });
    console.log(`Recipes — ${formatLoad(r)}`);
  }

  await pool.end();
  console.log('Done.');
}

// Run only when invoked directly, not when imported by the test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
