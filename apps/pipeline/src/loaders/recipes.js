/**
 * Loader: additional-data/datasets/recipes/recipes.json → recipes table
 *
 * LOAD_LIMIT=N — test mode, first N items
 */
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../lib/db.js';
import { loadRows } from '../lib/loader.js';

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

const COLUMNS  = ['title', 'slug', 'url', 'description', 'ingredients', 'instructions', 'image_url', 'category', 'tags', 'post_text', 'posted', 'raw'];
const CONFLICT = '(slug)';

/** Encode a JS array as a Postgres text[] literal */
function pgArray(arr) {
  if (!arr || !arr.length) return '{}';
  return `{${arr.map((t) => `"${String(t).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

function mapRecipe(recipe) {
  return {
    title:        recipe.title,
    slug:         recipe.slug || slugify(recipe.title),
    url:          recipe.url          ?? null,
    description:  recipe.description  ?? null,
    ingredients:  recipe.ingredients  ?? null,
    instructions: recipe.instructions ?? null,
    image_url:    recipe.image_url    ?? recipe.imageUrl ?? null,
    category:     recipe.category     ?? null,
    tags:         pgArray(recipe.tags),
    post_text:    recipe.post_text    ?? recipe.postText ?? null,
    posted:       '{}',
    // Strip NUL escapes — Postgres jsonb (and text) reject . Some source
    // recipes carry a stray null char in free-text fields (e.g. serving tips).
    raw:          recipe.raw ? JSON.stringify(recipe.raw).replace(/\\u0000/g, '') : null,
  };
}

async function main() {
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

  const FRESH = process.env.LOAD_FRESH === '1' || process.argv.includes('--fresh');
  if (FRESH) {
    console.log('Fresh load: TRUNCATE recipes');
    await pool.query('TRUNCATE recipes RESTART IDENTITY');
  }

  console.log(`Loading ${rows.length} recipes`);
  const { inserted, skipped } = await loadRows('recipes', rows, { columns: COLUMNS, conflictTarget: CONFLICT });
  console.log(`Recipes — inserted: ${inserted}, skipped: ${skipped}`);

  await pool.end();
  console.log('Done.');
}

main().catch((err) => { console.error(err); process.exit(1); });
