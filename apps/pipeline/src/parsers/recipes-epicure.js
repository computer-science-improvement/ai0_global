/**
 * Parser: raw-data/recipes/recipes_*.json (English epicure chunks)
 *         → data/normalized/recipes/recipes.json
 *
 * Maps each recipe onto the normalized shape the recipes loader expects.
 * Content stays English; the recipes strategy translates to Ukrainian at
 * post time. Dedupes exact duplicates and uniquifies slug collisions.
 */
import { createHash } from 'crypto';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_DIR   = join(__dirname, '..', 'raw-data', 'raw-data', 'recipes');
const OUT_FILE  = join(__dirname, '..', 'data', 'normalized', 'recipes', 'recipes.json');

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
}

export function buildIngredientsText(arr) {
  if (!Array.isArray(arr)) return null;
  const lines = arr
    .filter((i) => i && i.name)
    .map((i) => (i.quantity ? `${i.name} — ${i.quantity}` : String(i.name)));
  return lines.length ? lines.join('\n') : null;
}

export function buildInstructionsText(arr) {
  if (!Array.isArray(arr)) return null;
  const steps = arr.filter(Boolean).map((s, i) => `${i + 1}. ${s}`);
  return steps.length ? steps.join('\n') : null;
}

export function mapRecipe(raw) {
  const tags = [raw.dish_type, raw.flavor_profile, raw.cuisine_type, raw.hero_ingredient]
    .filter(Boolean)
    .map((t) => String(t).toLowerCase());
  return {
    title:        raw.recipe_name,
    slug:         slugify(raw.recipe_name),
    url:          null,
    description:  raw.visual_description ?? null,
    ingredients:  buildIngredientsText(raw.ingredients),
    instructions: buildInstructionsText(raw.instructions),
    image_url:    raw.image_url,
    category:     raw.cuisine_type ?? null,
    tags:         [...new Set(tags)],
    post_text:    null,
    raw,
  };
}

/**
 * Map a list of raw recipes → normalized recipes, dropping malformed entries
 * and exact duplicates (same name+image) and giving slug-collisions a unique
 * `-<hash>` suffix. Returns { recipes, skipped }.
 */
export function normalizeAll(rawRecipes) {
  const seenKeys  = new Set();
  const usedSlugs = new Set();
  const recipes   = [];
  let skipped = 0;

  for (const raw of rawRecipes) {
    if (!raw || !raw.recipe_name || !raw.image_url) { skipped++; continue; }
    const key = `${raw.recipe_name}::${raw.image_url}`;
    if (seenKeys.has(key)) { continue; }
    seenKeys.add(key);

    const mapped = mapRecipe(raw);
    if (usedSlugs.has(mapped.slug)) {
      const suffix = createHash('sha1').update(key).digest('hex').slice(0, 6);
      mapped.slug = `${mapped.slug}-${suffix}`.slice(0, 120);
    }
    usedSlugs.add(mapped.slug);
    recipes.push(mapped);
  }
  return { recipes, skipped };
}

async function main() {
  const files = (await readdir(RAW_DIR))
    .filter((f) => /^recipes_\d+\.json$/.test(f))
    .sort();
  if (!files.length) { console.error(`No recipe chunks in ${RAW_DIR}`); process.exit(1); }

  const all = [];
  for (const f of files) {
    const data = JSON.parse(await readFile(join(RAW_DIR, f), 'utf-8'));
    const arr = data.recipes ?? data;
    if (Array.isArray(arr)) all.push(...arr);
  }

  const { recipes, skipped } = normalizeAll(all);
  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify({ recipes }, null, 2), 'utf-8');
  console.log(`Parsed ${all.length} raw → ${recipes.length} normalized (${skipped} skipped) → ${OUT_FILE}`);
}

// Run only when invoked directly, not when imported by the test.
if (process.argv[1] && process.argv[1].endsWith('recipes-epicure.js')) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
