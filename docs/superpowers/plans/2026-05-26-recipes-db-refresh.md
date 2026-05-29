# Recipes DB Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move recipe posting off TheMealDB's live API onto our own `recipes` table, seeded from the English epicure dataset; the `recipes` strategy translates each recipe to Ukrainian via Claude lazily at post time and caches the translation in the DB.

**Architecture:** Pipeline side — a new parser normalizes the English epicure chunks into `data/normalized/recipes/recipes.json`, and the existing loader (gaining a `--fresh` TRUNCATE) loads them into `recipes`. Automation side — a migration adds `title_uk/ingredients_uk/instructions_uk/translated_at`; a new `RecipesRepository` selects the next unposted, untranslated-or-translated row; the rewritten `recipes` strategy translates-if-needed (caching), renders a Ukrainian photo caption (title + cuisine + ingredients) plus a follow-up reply with full instructions, publishes via `TelegramPublisher.publishPrompt`, and marks the row posted.

**Tech Stack:** Node ESM (pipeline, `pg`), NestJS + TypeScript (automation), Anthropic SDK (`ClaudeAgent`), Postgres. Tests: `node --test` (pipeline JS) and `node --import tsx --test` (automation TS), both using `node:test`.

**Spec:** `docs/superpowers/specs/2026-05-26-recipes-db-refresh-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `database/migrations/008_recipes_translation.sql` | **create** | Add `*_uk` + `translated_at` columns + partial index. |
| `database/init.sql` | **modify** | Mirror the four columns into the baseline `recipes` table. |
| `apps/pipeline/src/parsers/recipes-epicure.js` | **create** | Pure map/slug/dedup fns + a `main()` that reads `recipes/` chunks → writes normalized `recipes.json`. |
| `apps/pipeline/src/parsers/recipes-epicure.test.js` | **create** | `node:test` for the pure functions. |
| `apps/pipeline/src/loaders/recipes.js` | **modify** | Add `--fresh`/`LOAD_FRESH` TRUNCATE before load. |
| `apps/pipeline/package.json` | **modify** | Add `parse:recipes`, `load:recipes:fresh`, `test` scripts. |
| `apps/automation/src/common/ai/prompts/recipe-translate.prompts.ts` | **create** | Translation system prompt + user-message builder. |
| `apps/automation/src/common/ai/prompts/recipe-translate.prompts.test.ts` | **create** | `node:test` for the user-message builder. |
| `apps/automation/src/strategies/recipes/recipes.repository.ts` | **create** | `getNext` / `saveTranslation` / `markPosted`. |
| `apps/automation/src/strategies/recipes/recipes.strategy.ts` | **rewrite** | DB-backed `execute()` with lazy cached translation + photo+reply publish. |
| `apps/automation/src/strategies/recipes/recipes.strategy.test.ts` | **create** | `node:test` with fakes for the strategy. |
| `apps/automation/src/strategies/recipes/recipes-strategy.module.ts` | **modify** | Provide `RecipesRepository`; drop `MealDbFetcher`. |
| `apps/automation/src/workflows/recipes/fetchers/mealdb.fetcher.ts` | **delete** | TheMealDB retired. |

DB-bound units (`recipes.repository.ts`, the `--fresh` loader, the migration) are verified against local Postgres in Task 9 (manual, cost-safe) — consistent with the repo, which has no DB-bound unit tests.

---

## Task 1: Migration 008 + init.sql columns

**Files:**
- Create: `database/migrations/008_recipes_translation.sql`
- Modify: `database/init.sql` (recipes table definition)

- [ ] **Step 1: Write the migration**

Create `database/migrations/008_recipes_translation.sql`:

```sql
-- 008_recipes_translation.sql
-- Cache Claude's Ukrainian translation of each recipe directly on the row so a
-- publish retry never re-pays for translation. Columns are NULL until the
-- recipes strategy translates the row on first post; an empty title_uk is a
-- "skip this row" sentinel for recipes Claude refused to translate.

ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS title_uk        TEXT,
  ADD COLUMN IF NOT EXISTS ingredients_uk  TEXT,
  ADD COLUMN IF NOT EXISTS instructions_uk TEXT,
  ADD COLUMN IF NOT EXISTS translated_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_recipes_untranslated
  ON recipes (created_at) WHERE title_uk IS NULL;

INSERT INTO schema_migrations (version) VALUES ('008_recipes_translation')
  ON CONFLICT (version) DO NOTHING;
```

- [ ] **Step 2: Mirror the columns into init.sql**

In `database/init.sql`, find the `CREATE TABLE recipes (...)` block. Add the four columns just before `created_at`:

```sql
  post_text    TEXT,
  posted       JSONB NOT NULL DEFAULT '{}',
  title_uk        TEXT,
  ingredients_uk  TEXT,
  instructions_uk TEXT,
  translated_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
```

And add, alongside the other recipes indexes:

```sql
CREATE INDEX idx_recipes_untranslated ON recipes (created_at) WHERE title_uk IS NULL;
```

- [ ] **Step 3: Apply to local Postgres and verify**

Run (adjust container/db name if different — `docker ps` to confirm; memory: `ai0_global-postgres-1`, user `ai0`, db `ai0global`):

```bash
docker exec -i ai0_global-postgres-1 psql -U ai0 -d ai0global < database/migrations/008_recipes_translation.sql
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c "\d recipes" | grep -E "title_uk|ingredients_uk|instructions_uk|translated_at"
```

Expected: the four columns are listed; the command exits 0.

- [ ] **Step 4: Commit**

```bash
git add database/migrations/008_recipes_translation.sql database/init.sql
git commit -m "$(cat <<'EOF'
feat(db): migration 008 — recipe translation cache columns

Add title_uk/ingredients_uk/instructions_uk/translated_at to recipes so
the recipes strategy can cache Claude's Ukrainian translation per row.
Partial index on untranslated rows. Mirrored into init.sql for fresh DBs.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Recipe parser (epicure → normalized)

**Files:**
- Create: `apps/pipeline/src/parsers/recipes-epicure.js`
- Test: `apps/pipeline/src/parsers/recipes-epicure.test.js`
- Modify: `apps/pipeline/package.json`

- [ ] **Step 1: Write the failing test**

Create `apps/pipeline/src/parsers/recipes-epicure.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slugify, buildIngredientsText, buildInstructionsText, mapRecipe, normalizeAll,
} from './recipes-epicure.js';

const RAW = {
  recipe_name: 'Classic Pommes Anna',
  image_url: 'https://x/img.jpg',
  dish_type: 'main',
  flavor_profile: 'savory',
  cuisine_type: 'French',
  hero_ingredient: 'Potato',
  visual_description: 'Golden-brown.',
  ingredients: [{ name: 'Potato', quantity: '1 kg' }, { name: 'Butter', quantity: '150 g' }],
  instructions: ['Melt butter.', 'Slice potato.'],
};

test('slugify lowercases, strips punctuation, dashes spaces', () => {
  assert.equal(slugify('Classic Pommes Anna!'), 'classic-pommes-anna');
});

test('buildIngredientsText joins "name — quantity" per line', () => {
  assert.equal(buildIngredientsText(RAW.ingredients), 'Potato — 1 kg\nButter — 150 g');
});

test('buildInstructionsText numbers steps', () => {
  assert.equal(buildInstructionsText(RAW.instructions), '1. Melt butter.\n2. Slice potato.');
});

test('mapRecipe maps all fields onto the normalized shape', () => {
  const r = mapRecipe(RAW);
  assert.equal(r.title, 'Classic Pommes Anna');
  assert.equal(r.slug, 'classic-pommes-anna');
  assert.equal(r.description, 'Golden-brown.');
  assert.equal(r.ingredients, 'Potato — 1 kg\nButter — 150 g');
  assert.equal(r.instructions, '1. Melt butter.\n2. Slice potato.');
  assert.equal(r.image_url, 'https://x/img.jpg');
  assert.equal(r.category, 'French');
  assert.deepEqual(r.tags, ['main', 'savory', 'french', 'potato']);
  assert.equal(r.post_text, null);
});

test('normalizeAll drops malformed entries and exact dupes, uniquifies slug collisions', () => {
  const a = { ...RAW };
  const aDupe = { ...RAW };                       // same name + image -> dropped
  const b = { ...RAW, image_url: 'https://x/2.jpg' }; // same name, diff image -> kept, unique slug
  const bad = { image_url: 'https://x/3.jpg' };   // no recipe_name -> dropped
  const { recipes, skipped } = normalizeAll([a, aDupe, b, bad]);
  assert.equal(recipes.length, 2);
  assert.equal(skipped, 1);
  assert.notEqual(recipes[0].slug, recipes[1].slug);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/pipeline && node --test src/parsers/recipes-epicure.test.js`
Expected: FAIL — `Cannot find module './recipes-epicure.js'`.

- [ ] **Step 3: Implement the parser**

Create `apps/pipeline/src/parsers/recipes-epicure.js`:

```js
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
    if (seenKeys.has(key)) { skipped++; continue; }
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/pipeline && node --test src/parsers/recipes-epicure.test.js`
Expected: PASS — 5 tests, 0 fail.

- [ ] **Step 5: Add npm scripts**

In `apps/pipeline/package.json` `scripts`, add:

```json
    "test": "node --test",
    "parse:recipes": "node src/parsers/recipes-epicure.js",
```

- [ ] **Step 6: Commit**

```bash
git add apps/pipeline/src/parsers/recipes-epicure.js apps/pipeline/src/parsers/recipes-epicure.test.js apps/pipeline/package.json
git commit -m "$(cat <<'EOF'
feat(pipeline): epicure recipe parser → normalized recipes.json

New parser flattens raw-data/recipes/ chunks, maps each recipe onto the
loader's normalized shape (English; translation happens at post time),
drops malformed/duplicate entries, and uniquifies slug collisions.
Unit-tested with node:test; adds parse:recipes + test scripts.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Loader `--fresh` (clear-and-reload)

**Files:**
- Modify: `apps/pipeline/src/loaders/recipes.js`
- Modify: `apps/pipeline/package.json`

- [ ] **Step 1: Add the TRUNCATE branch**

In `apps/pipeline/src/loaders/recipes.js`, inside `main()`, after the block that builds `rows` and applies `LIMIT`, and after the `if (!rows.length) { … return; }` guard, insert the fresh-truncate (so we only truncate when there is real data to load):

```js
  const FRESH = process.env.LOAD_FRESH === '1' || process.argv.includes('--fresh');
  if (FRESH) {
    console.log('Fresh load: TRUNCATE recipes');
    await pool.query('TRUNCATE recipes RESTART IDENTITY');
  }
```

(Place it immediately before `console.log(\`Loading ${rows.length} recipes\`);`.)

- [ ] **Step 2: Add the npm script**

In `apps/pipeline/package.json` `scripts`, add:

```json
    "load:recipes:fresh": "LOAD_FRESH=1 node --env-file=../../.env src/loaders/recipes.js",
```

- [ ] **Step 3: Verify syntax (no DB needed here)**

Run: `cd apps/pipeline && node --check src/loaders/recipes.js`
Expected: no output, exit 0.

(Functional DB verification — idempotency + truncate — happens in Task 9 against local Postgres.)

- [ ] **Step 4: Commit**

```bash
git add apps/pipeline/src/loaders/recipes.js apps/pipeline/package.json
git commit -m "$(cat <<'EOF'
feat(pipeline): recipes loader --fresh TRUNCATE option

LOAD_FRESH=1 (or --fresh) clears the recipes table before loading, guarded
so an empty normalized file never wipes the table. Adds load:recipes:fresh.
Existing load:recipes stays incremental + idempotent (ON CONFLICT slug).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Translation prompt

**Files:**
- Create: `apps/automation/src/common/ai/prompts/recipe-translate.prompts.ts`
- Test: `apps/automation/src/common/ai/prompts/recipe-translate.prompts.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/common/ai/prompts/recipe-translate.prompts.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECIPE_TRANSLATE_PROMPT, buildRecipeTranslateUserMessage } from './recipe-translate.prompts';

test('translate system prompt demands strict JSON with the three _uk fields', () => {
  const s = RECIPE_TRANSLATE_PROMPT.system;
  assert.match(s, /title_uk/);
  assert.match(s, /ingredients_uk/);
  assert.match(s, /instructions_uk/);
  assert.match(s, /JSON/i);
});

test('user message carries the English source fields', () => {
  const msg = buildRecipeTranslateUserMessage({
    title: 'Classic Pommes Anna',
    category: 'French',
    ingredients: 'Potato — 1 kg',
    instructions: '1. Melt butter.',
  });
  assert.match(msg, /Classic Pommes Anna/);
  assert.match(msg, /French/);
  assert.match(msg, /Potato — 1 kg/);
  assert.match(msg, /Melt butter/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/automation && node --import tsx --test src/common/ai/prompts/recipe-translate.prompts.test.ts`
Expected: FAIL — cannot find module `./recipe-translate.prompts`.

- [ ] **Step 3: Implement the prompt**

Create `apps/automation/src/common/ai/prompts/recipe-translate.prompts.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/automation && node --import tsx --test src/common/ai/prompts/recipe-translate.prompts.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/common/ai/prompts/recipe-translate.prompts.ts apps/automation/src/common/ai/prompts/recipe-translate.prompts.test.ts
git commit -m "$(cat <<'EOF'
feat(ai): recipe translation prompt (EN → UA, strict JSON)

System prompt + user-message builder that localizes an English recipe
into {title_uk, ingredients_uk, instructions_uk}, composing the existing
human-voice / anti-slop / recipes-channel skills. Emits SKIP_POST when
unusable. Unit-tested with node:test.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: RecipesRepository

**Files:**
- Create: `apps/automation/src/strategies/recipes/recipes.repository.ts`

(No standalone unit test — DB-bound, verified in Task 9, matching repo conventions. It must compile and be exercised by the strategy test via a fake.)

- [ ] **Step 1: Implement the repository**

Create `apps/automation/src/strategies/recipes/recipes.repository.ts`:

```ts
import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';

export interface RecipeRow {
  id:              string;
  title:           string;
  image_url:       string;
  category:        string | null;
  ingredients:     string | null;
  instructions:    string | null;
  title_uk:        string | null;
  ingredients_uk:  string | null;
  instructions_uk: string | null;
}

export interface RecipeTranslation {
  titleUk:        string;
  ingredientsUk:  string;
  instructionsUk: string;
}

@Injectable()
export class RecipesRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /**
   * Next recipe to post: not yet posted to Telegram, and not a "skip" sentinel
   * (empty title_uk). Oldest-first for deterministic ordering. A NULL title_uk
   * means "not translated yet" → the strategy translates it; a non-empty
   * title_uk means "already translated" → reuse it.
   */
  async getNext(): Promise<RecipeRow | null> {
    const { rows } = await this.pool.query<RecipeRow>(
      `SELECT id, title, image_url, category, ingredients, instructions,
              title_uk, ingredients_uk, instructions_uk
       FROM recipes
       WHERE NOT (posted ? 'TELEGRAM')
         AND title_uk IS DISTINCT FROM ''
       ORDER BY created_at
       LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  /** Cache a translation (or the empty-string skip sentinel) on the row. */
  async saveTranslation(id: string, t: RecipeTranslation): Promise<void> {
    await this.pool.query(
      `UPDATE recipes
       SET title_uk = $2, ingredients_uk = $3, instructions_uk = $4, translated_at = now()
       WHERE id = $1`,
      [id, t.titleUk, t.ingredientsUk, t.instructionsUk],
    );
  }

  /** Mark the row published to Telegram. */
  async markPosted(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE recipes
       SET posted = posted || jsonb_build_object('TELEGRAM', to_jsonb(now()))
       WHERE id = $1`,
      [id],
    );
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/automation && npx tsc --noEmit -p tsconfig.json`
Expected: no errors. (If the project lacks a direct `tsc` path, `node --import tsx --eval "import('./src/strategies/recipes/recipes.repository.ts')"` also confirms it parses; prefer `nest build` in Task 8's verification.)

- [ ] **Step 3: Commit**

```bash
git add apps/automation/src/strategies/recipes/recipes.repository.ts
git commit -m "$(cat <<'EOF'
feat(recipes): RecipesRepository (getNext/saveTranslation/markPosted)

getNext returns the oldest unposted, non-sentinel recipe; saveTranslation
caches title_uk/ingredients_uk/instructions_uk (+ translated_at); markPosted
flips the posted JSONB. Skip-sentinel = empty title_uk.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Rewrite the recipes strategy

**Files:**
- Rewrite: `apps/automation/src/strategies/recipes/recipes.strategy.ts`
- Test: `apps/automation/src/strategies/recipes/recipes.strategy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/strategies/recipes/recipes.strategy.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecipesStrategy } from './recipes.strategy';

function makeRow(over = {}) {
  return {
    id: 'r1', title: 'Pommes Anna', image_url: 'https://x/i.jpg', category: 'French',
    ingredients: 'Potato — 1 kg', instructions: '1. Melt butter.',
    title_uk: null, ingredients_uk: null, instructions_uk: null, ...over,
  };
}

function build(overrides = {}) {
  const calls = { chat: 0, save: [], posted: [], published: [] as any[] };
  const claude = { available: true, chat: async () => { calls.chat++; return JSON.stringify({
    title_uk: 'Пом Анна', ingredients_uk: 'Картопля — 1 кг', instructions_uk: '1. Розтопіть масло.',
  }); }, ...((overrides as any).claude ?? {}) };
  const validator = { check: () => true, ...((overrides as any).validator ?? {}) };
  const registry = { register() {} };
  const publisher = { publishPrompt: async (p: any) => { calls.published.push(p); return '42'; } };
  const repo = {
    getNext: async () => (overrides as any).row ?? makeRow(),
    saveTranslation: async (id: string, t: any) => { calls.save.push({ id, t }); },
    markPosted: async (id: string) => { calls.posted.push(id); },
  };
  const notifier = { notifyPublished: async () => {} };
  const publications = { insert: async () => {} };
  const s = new RecipesStrategy(
    claude as any, validator as any, registry as any, publisher as any,
    repo as any, notifier as any, publications as any,
  );
  // Avoid network in tests.
  (s as any).downloadImage = async () => Buffer.from('img');
  return { s, calls };
}

test('untranslated row: translates once, caches, publishes, marks posted', async () => {
  const { s, calls } = build();
  await s.execute('@chan', {});
  assert.equal(calls.chat, 1);
  assert.equal(calls.save.length, 1);
  assert.equal(calls.published.length, 1);
  const pub = calls.published[0];
  assert.ok(pub.caption.includes('Пом Анна'));
  assert.ok(pub.caption.includes('Картопля — 1 кг'));
  assert.ok(pub.replyText.includes('Розтопіть масло'));
  assert.deepEqual(calls.posted, ['r1']);
});

test('already-translated row: does NOT call Claude', async () => {
  const row = makeRow({ title_uk: 'Пом Анна', ingredients_uk: 'Картопля — 1 кг', instructions_uk: '1. Готуйте.' });
  const { s, calls } = build({ row });
  await s.execute('@chan', {});
  assert.equal(calls.chat, 0);
  assert.equal(calls.published.length, 1);
  assert.deepEqual(calls.posted, ['r1']);
});

test('SKIP_POST: writes empty sentinel, no publish, no markPosted', async () => {
  const { s, calls } = build({ claude: { available: true, chat: async () => 'SKIP_POST' } });
  await s.execute('@chan', {});
  assert.equal(calls.save.length, 1);
  assert.equal(calls.save[0].t.titleUk, '');
  assert.equal(calls.published.length, 0);
  assert.equal(calls.posted.length, 0);
});

test('image download failure: no markPosted (retry next run)', async () => {
  const { s, calls } = build();
  (s as any).downloadImage = async () => { throw new Error('net'); };
  await s.execute('@chan', {});
  assert.equal(calls.published.length, 0);
  assert.equal(calls.posted.length, 0);
});

test('no unposted rows: no-op', async () => {
  const { s, calls } = build({ row: null });
  // getNext returns overrides.row which is null
  await s.execute('@chan', {});
  assert.equal(calls.published.length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/automation && node --import tsx --test src/strategies/recipes/recipes.strategy.test.ts`
Expected: FAIL — the current strategy has a different constructor and no `downloadImage`/DB-backed `execute`.

- [ ] **Step 3: Rewrite the strategy**

Replace the entire contents of `apps/automation/src/strategies/recipes/recipes.strategy.ts`:

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import { ClaudeAgent }             from '../../common/ai/agents/claude.agent';
import { PostValidator }           from '../../common/ai/validators/post.validator';
import { ContentStrategyRegistry } from '../../common/content-strategy/content-strategy.registry';
import { TelegramPublisher }       from '../../publishers/telegram.publisher';
import { TelegramNotifier }        from '../../publishers/telegram-notifier.service';
import { PublicationsRepository }  from '../../stats/publications.repository';
import { RECIPES_CHANNEL_SKILL }   from '../../common/ai/skills/recipes-channel.skill';
import { Skill }                   from '../../common/ai/skills/skill.interface';
import {
  RECIPE_TRANSLATE_PROMPT, buildRecipeTranslateUserMessage,
} from '../../common/ai/prompts/recipe-translate.prompts';
import {
  ContentStrategy, StrategyFetchResult, StrategyPost, StrategyParams,
} from '../../common/content-strategy/content-strategy.interface';
import { RecipesRepository, RecipeRow } from './recipes.repository';

const CAPTION_MAX = 1024;
const REPLY_MAX   = 4096;
const USER_AGENT  =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

@Injectable()
export class RecipesStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(RecipesStrategy.name);
  readonly type = 'recipes';

  constructor(
    private readonly claude:       ClaudeAgent,
    private readonly validator:    PostValidator,
    private readonly registry:     ContentStrategyRegistry,
    private readonly publisher:    TelegramPublisher,
    private readonly repo:         RecipesRepository,
    private readonly notifier:     TelegramNotifier,
    private readonly publications: PublicationsRepository,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  getSkills(_params: StrategyParams): Skill[] {
    return [RECIPES_CHANNEL_SKILL];
  }

  // Unused: this strategy drives itself via execute().
  async fetch(_params: StrategyParams, _channelId: string): Promise<StrategyFetchResult | null> {
    return null;
  }
  async generate(_data: StrategyFetchResult, _params: StrategyParams): Promise<StrategyPost | 'SKIP_POST' | null> {
    return null;
  }

  async execute(channelId: string, _params: StrategyParams): Promise<void> {
    const row = await this.repo.getNext();
    if (!row) { this.logger.debug('No unposted recipes'); return; }

    const uk = await this.resolveTranslation(row);
    if (!uk) return; // translation unavailable/failed (sentinel already handled)

    const caption   = this.buildCaption(uk.titleUk, row.category, uk.ingredientsUk);
    const replyText = this.buildReply(uk.instructionsUk);

    let imageBuffer: Buffer;
    try {
      imageBuffer = await this.downloadImage(row.image_url);
    } catch (err: any) {
      this.logger.warn(`Image download failed (${row.id}): ${err.message}`);
      return; // do not mark posted — retry next run (translation already cached)
    }

    try {
      const messageId = await this.publisher.publishPrompt(
        { imageBuffer, caption, replyText: replyText || undefined },
        { id: channelId },
      );
      await this.repo.markPosted(row.id);
      await this.notifier.notifyPublished(channelId, messageId);
      await this.publications.insert({
        channelId, messageId,
        sourceUrl:    row.image_url,
        title:        uk.titleUk.slice(0, 200),
        strategyType: this.type,
        tags:         row.category ? [row.category] : [],
      });
      this.logger.debug(`Published recipe ${row.id} to ${channelId}`);
    } catch (err: any) {
      this.logger.error(`Publish failed (${row.id}): ${err.message}`);
    }
  }

  /**
   * Return the Ukrainian fields for a row, translating + caching on first use.
   * Returns null when we must abort this run:
   *   - Claude unavailable → retry later (no sentinel written).
   *   - bad translation (SKIP_POST / invalid JSON / missing fields / validator
   *     reject) → write the empty-title sentinel so the row is skipped forever
   *     (caps translation cost to one attempt per row).
   */
  private async resolveTranslation(
    row: RecipeRow,
  ): Promise<{ titleUk: string; ingredientsUk: string; instructionsUk: string } | null> {
    if (row.title_uk !== null && row.title_uk !== '') {
      return {
        titleUk:        row.title_uk,
        ingredientsUk:  row.ingredients_uk ?? '',
        instructionsUk: row.instructions_uk ?? '',
      };
    }

    if (!this.claude.available) { this.logger.warn('Claude not available'); return null; }

    const raw = await this.claude.chat([
      { role: 'system', content: RECIPE_TRANSLATE_PROMPT.system },
      { role: 'user',   content: buildRecipeTranslateUserMessage(row) },
    ]);

    const fail = async (why: string) => {
      this.logger.warn(`Translation rejected (${row.id}): ${why} — writing skip sentinel`);
      await this.repo.saveTranslation(row.id, { titleUk: '', ingredientsUk: '', instructionsUk: '' });
      return null;
    };

    if (!raw || raw.trim() === 'SKIP_POST') return fail('empty or SKIP_POST');
    if (!this.validator.check(raw, 'recipes')) return fail('validator rejected');

    let parsed: { title_uk?: string; ingredients_uk?: string; instructions_uk?: string };
    try {
      parsed = JSON.parse(raw.replace(/```json\s*/g, '').replace(/```\s*/g, ''));
    } catch {
      return fail('invalid JSON');
    }
    if (!parsed.title_uk || !parsed.ingredients_uk || !parsed.instructions_uk) {
      return fail('missing fields');
    }

    const uk = {
      titleUk:        parsed.title_uk,
      ingredientsUk:  parsed.ingredients_uk,
      instructionsUk: parsed.instructions_uk,
    };
    await this.repo.saveTranslation(row.id, uk);
    return uk;
  }

  private buildCaption(title: string, category: string | null, ingredients: string): string {
    const header = `<b>${title}</b>`;
    const meta   = category ? `🍽️ ${category}` : '';
    const ingHdr = '📝 Інгредієнти:';
    const fixed  = [header, meta, `${ingHdr}\n`].filter(Boolean).join('\n\n');
    const budget = CAPTION_MAX - fixed.length;
    const lines  = this.fitLines(ingredients, budget);
    return [header, meta, `${ingHdr}\n${lines}`].filter(Boolean).join('\n\n');
  }

  private buildReply(instructions: string): string {
    const head = '👨‍🍳 Приготування:\n';
    const full = head + (instructions ?? '');
    if (full.length <= REPLY_MAX) return full;
    const sliced = full.slice(0, REPLY_MAX - 1);
    const nl = sliced.lastIndexOf('\n');
    return (nl > head.length ? sliced.slice(0, nl) : sliced) + '…';
  }

  /** Keep whole '\n'-separated lines that fit within budget. */
  private fitLines(block: string, budget: number): string {
    const out: string[] = [];
    let used = 0;
    for (const line of (block ?? '').split('\n')) {
      const add = used === 0 ? line.length : line.length + 1;
      if (used + add > budget) break;
      out.push(line);
      used += add;
    }
    return out.join('\n');
  }

  private async downloadImage(url: string): Promise<Buffer> {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15_000,
    });
    return Buffer.from(res.data);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/automation && node --import tsx --test src/strategies/recipes/recipes.strategy.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/strategies/recipes/recipes.strategy.ts apps/automation/src/strategies/recipes/recipes.strategy.test.ts
git commit -m "$(cat <<'EOF'
feat(recipes): DB-backed recipes strategy with cached UA translation

Rewrite the 'recipes' strategy to drive itself via execute(): pull the
next unposted recipe, translate to Ukrainian via Claude only if not yet
cached (storing the result), render a photo caption (title + cuisine +
ingredients) plus a reply with full instructions, publish via
publishPrompt, and mark posted. Bad translations get a one-shot skip
sentinel; image/publish failures don't mark posted. Unit-tested with
fakes (no network/Claude/Telegram).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Wire the module + retire MealDbFetcher

**Files:**
- Modify: `apps/automation/src/strategies/recipes/recipes-strategy.module.ts`
- Delete: `apps/automation/src/workflows/recipes/fetchers/mealdb.fetcher.ts`

- [ ] **Step 1: Confirm no other importers of MealDbFetcher**

Run: `cd apps/automation && grep -rn "mealdb.fetcher\|MealDbFetcher" src | grep -v "recipes-strategy.module.ts"`
Expected: no matches (after Task 6, the strategy no longer imports it). If any appear, stop and report — do not delete.

- [ ] **Step 2: Update the module**

Replace `apps/automation/src/strategies/recipes/recipes-strategy.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { RecipesStrategy }   from './recipes.strategy';
import { RecipesRepository } from './recipes.repository';

@Module({
  providers: [RecipesStrategy, RecipesRepository],
  exports:   [RecipesStrategy],
})
export class RecipesStrategyModule {}
```

- [ ] **Step 3: Delete the fetcher**

Run: `cd apps/automation && git rm src/workflows/recipes/fetchers/mealdb.fetcher.ts`

(Leave `src/workflows/recipes/types.ts` in place — only remove it if Step 1's grep proved nothing imports `RecipeItem` anymore; the strategy no longer does, but other workflows might.)

- [ ] **Step 4: Build to verify DI + types**

Run: `cd apps/automation && pnpm run build`
Expected: `nest build` succeeds with no errors. (This confirms `RecipesRepository` resolves `DB_POOL` from the global database module and the strategy's new deps are all globally provided.)

- [ ] **Step 5: Run the full automation test suite**

Run: `cd apps/automation && node --import tsx --test "src/**/*.test.ts"`
Expected: all tests pass (existing suite + the two new files).

- [ ] **Step 6: Commit**

```bash
git add apps/automation/src/strategies/recipes/recipes-strategy.module.ts
git commit -m "$(cat <<'EOF'
refactor(recipes): wire RecipesRepository, retire TheMealDB fetcher

Module now provides RecipesStrategy + RecipesRepository. MealDbFetcher
deleted — the strategy is DB-backed. nest build + full test suite green.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Audit existing loaders

**Files:** read-only audit; fixes only if a real bug is found.

- [ ] **Step 1: Audit each loader**

For each of `apps/pipeline/src/loaders/{recipes,prompts,daytoday,facts,pdr,tg-posts,treatfield,assets}.js`, read the file and confirm:
- the input path it reads exists or is documented,
- the target table matches its filename/purpose,
- `conflictTarget` matches a real unique index on that table (cross-check `database/init.sql` + migrations),
- `node --check <file>` parses.

Run the parse check across all:

```bash
cd apps/pipeline && for f in src/loaders/*.js; do node --check "$f" && echo "ok: $f"; done
```

Expected: every loader prints `ok:`.

- [ ] **Step 2: Record findings**

Append a short "Loader audit (2026-05-26)" note to the bottom of `docs/superpowers/specs/2026-05-26-recipes-db-refresh-design.md` listing, per loader: input path, table, conflict key, and PASS or the bug found. Fix only clear bugs (e.g. a `conflictTarget` that names a non-existent index); if you fix one, show the diff in the note.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-05-26-recipes-db-refresh-design.md apps/pipeline/src/loaders/
git commit -m "$(cat <<'EOF'
chore(pipeline): audit existing loaders

Verified input paths, target tables, and ON CONFLICT keys for all 8
loaders; results recorded in the recipes spec. [Note any fixes here.]

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Integration verify (cost-safe — local DB only, no Claude/Telegram)

**No code changes.** Confirms parser → loader → DB end-to-end and the repository SQL, without binding the strategy or running automation (so no Claude/Telegram).

- [ ] **Step 1: Ensure Postgres is up + migration applied**

```bash
docker ps | grep postgres                      # confirm the container is running
# (Migration 008 was applied in Task 1.)
```

- [ ] **Step 2: Parse a real subset**

```bash
cd apps/pipeline && pnpm run parse:recipes
head -c 600 src/data/normalized/recipes/recipes.json
```

Expected: prints "Parsed N raw → M normalized (K skipped)"; the JSON has a `recipes` array with `title/slug/ingredients/instructions/image_url/category/tags`.

- [ ] **Step 3: Fresh-load a capped subset**

```bash
cd apps/pipeline && LOAD_LIMIT=20 pnpm run load:recipes:fresh
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c \
  "SELECT count(*) AS n, count(*) FILTER (WHERE title_uk IS NULL) AS untranslated FROM recipes;"
```

Expected: `n = 20`, `untranslated = 20`.

- [ ] **Step 4: Verify idempotency (no `--fresh`)**

```bash
cd apps/pipeline && LOAD_LIMIT=20 pnpm run load:recipes
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c "SELECT count(*) FROM recipes;"
```

Expected: still `20` (ON CONFLICT(slug) skipped re-inserts; loader prints `skipped: 20`).

- [ ] **Step 5: Verify repository SQL by hand**

```bash
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c \
  "SELECT id,title FROM recipes WHERE NOT (posted ? 'TELEGRAM') AND title_uk IS DISTINCT FROM '' ORDER BY created_at LIMIT 1;"
# simulate a skip-sentinel and confirm getNext would skip it:
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c \
  "UPDATE recipes SET title_uk='' WHERE id=(SELECT id FROM recipes ORDER BY created_at LIMIT 1);
   SELECT count(*) FROM recipes WHERE NOT (posted ? 'TELEGRAM') AND title_uk IS DISTINCT FROM '';"
```

Expected: first query returns one row; after the sentinel update the count drops by 1.

- [ ] **Step 6: Full fresh load (optional, once translation source is final)**

Only when you want the complete dataset loaded for real:

```bash
cd apps/pipeline && pnpm run load:recipes:fresh
```

- [ ] **Step 7: Confirm cost-safety posture**

Verify the `recipes` strategy is **not bound** to a channel in the active config (or automation is not running), so no live translation/publish occurs. Per the standing rule, do not bind it during development.

```bash
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c \
  "SELECT ext_id, enabled FROM strategy_bindings WHERE type='recipes';"
```

Expected: no enabled `recipes` binding (or none at all) on the local/dev config. If one exists and you don't intend to post, leave it disabled.

---

## Self-Review

**Spec coverage:**
- Replace strategy to read DB → Task 6 ✅
- English source `recipes/` → Task 2 (`RAW_DIR`) ✅
- Load all, dedup slug → Task 2 `normalizeAll` + Task 3 loader ✅
- Lazy translation cached → Task 6 `resolveTranslation` + Task 5 `saveTranslation` ✅
- Structured `*_uk` columns + `translated_at` → Task 1 ✅
- Photo caption + instructions reply → Task 6 `buildCaption`/`buildReply` + `publishPrompt` ✅
- Migration 008 + init.sql mirror → Task 1 ✅
- Parser → normalized JSON → Task 2 ✅
- Loader `--fresh` + idempotent → Task 3 + Task 9 ✅
- Translation prompt → Task 4 ✅
- Repository getNext/saveTranslation/markPosted + poison sentinel → Task 5 (`IS DISTINCT FROM ''`) + Task 6 ✅
- Retire TheMealDB → Task 7 ✅
- Loader audit → Task 8 ✅
- Cost-safe testing (mocks; strategy unbound) → Tasks 2/4/6 (no network) + Task 9 Step 7 ✅

**Placeholder scan:** none — every code/command step is concrete. (Task 8 Step 2's "[Note any fixes here.]" is an instruction to the implementer to record audit results, not a code placeholder.)

**Type consistency:** `RecipeRow` fields (`title_uk`, `ingredients_uk`, `instructions_uk`, `image_url`, `category`, `ingredients`, `instructions`, `id`, `title`) are identical across Task 5 (repo), Task 6 (strategy + test fakes). `saveTranslation({titleUk, ingredientsUk, instructionsUk})` matches between Task 5 and Task 6. `getNext`/`markPosted` names match. The normalized object keys from Task 2 (`title, slug, url, description, ingredients, instructions, image_url, category, tags, post_text`) match the loader's `COLUMNS`/`mapRecipe` in `apps/pipeline/src/loaders/recipes.js`. `RECIPE_TRANSLATE_PROMPT.system` + `buildRecipeTranslateUserMessage` names match between Task 4 and Task 6.
