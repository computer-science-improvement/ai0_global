# Recipes DB Refresh — Design

**Date:** 2026-05-26
**Status:** Approved (brainstorming)
**Scope:** Recipes only. The two prompt imports (awesome-nanobanana-pro, awesome-seedance) are a **separate, later spec** that will extend the `prompts` table with stored prompt text + a `media_type` column and add a new posting strategy.

## Goal

Switch the recipe content source from TheMealDB's live API to our own Postgres `recipes` table, seeded from the new **pre-translated Ukrainian** epicure dataset. Posting becomes fully deterministic — **zero Claude calls** — because the data already arrives in Ukrainian.

## Context (current state)

- **Existing `recipes` strategy** (`apps/automation/src/strategies/recipes/recipes.strategy.ts`) fetches a random recipe from TheMealDB (`MealDbFetcher`) and uses Claude to produce a Ukrainian description. It **ignores the `recipes` table** entirely.
- **`recipes` table** (`database/init.sql`): `id, title, slug, url, description, ingredients TEXT, instructions TEXT, image_url, category, tags TEXT[], post_text, posted JSONB, created_at`. Unique index on `slug`. `posted` is a JSONB map like `{TELEGRAM: "<ts>"}`.
- **Existing recipes loader** (`apps/pipeline/src/loaders/recipes.js`) loads `data/normalized/recipes/recipes.json` into `recipes` with `ON CONFLICT (slug) DO NOTHING`.
- **New source data:** `apps/pipeline/src/raw-data/raw-data/recipes-ua/recipes_*.json` — produced by a separate translation agent (in progress; `translation_state.json` tracks position). Same epicure schema as the English `recipes/` chunks, but every text field is Ukrainian.
- **Publisher:** `TelegramPublisher.publishPrompt({ imageBuffer, caption, replyText? }, target)` sends a photo+caption, then an optional reply with `replyText`. Requires `imageBuffer: Buffer`. This is the exact mechanism the recipe post needs.

### Source recipe shape (recipes-ua, Ukrainian)

```json
{
  "recipe_name": "Класичний Пом Анна (Pommes Anna)",
  "image_url": "https://storage.googleapis.com/epicure-generated-images-kaikaku-bi/generated_image_...jpg",
  "dish_type": "основна страва",
  "flavor_profile": "солоний",
  "cuisine_type": "Французька",
  "hero_ingredient": "Картопля",
  "number_of_servings": 4,
  "visual_description": "Золотисто-коричнева картопля Пом Анна ...",
  "ingredients": [ { "name": "Картопля сорту Юкон Голд", "quantity": "1 кг" }, ... ],
  "instructions": [ "Розтопіть вершкове масло ...", ... ]
}
```

## Decisions (locked during brainstorming)

1. **Replace** the existing `recipes` strategy to read from the DB (keep the type name `recipes`; channel bindings unchanged). TheMealDB fetcher is retired.
2. **Source = `recipes-ua/`** (Ukrainian). No translation needed.
3. **Load all** recipes, dedup on `slug`.
4. **Zero Claude** at post time — deterministic formatting.
5. **Post layout** = photo + caption (title + meta + ingredients) **then a follow-up reply** with the full numbered instructions.

## Architecture / data flow

```
raw-data/recipes-ua/recipes_*.json   (Ukrainian, epicure schema, growing as translation runs)
        │  NEW parser: parsers/recipes-epicure.js  (map + slug-dedup)
        ▼
data/normalized/recipes/recipes.json
        │  loader: loaders/recipes.js  (+ --fresh TRUNCATE option; ON CONFLICT(slug) DO NOTHING)
        ▼
Postgres: recipes table
        │  recipes strategy execute():  getNext() → format → download image → publishPrompt → markPosted
        ▼
Telegram: photo+caption (ingredients) + reply (instructions)   |   recipes.posted = {TELEGRAM: ts}
```

## Components

### 1. Parser — `apps/pipeline/src/parsers/recipes-epicure.js` (NEW)

- Read every `recipes-ua/recipes_*.json` chunk (ignore `index.json`, `translation_state.json`).
- Flatten each chunk's `recipes[]`.
- Map each recipe to the normalized shape (no schema change — reuses existing columns):

  | normalized field | source |
  |---|---|
  | `title` | `recipe_name` |
  | `slug` | `slugify(recipe_name)`; on collision append `-<6-char hash>` of `recipe_name + image_url` |
  | `url` | `null` |
  | `description` | `visual_description` |
  | `ingredients` (TEXT) | `ingredients[]` joined as `"<name> — <quantity>"` per line |
  | `instructions` (TEXT) | `instructions[]` joined as `"1. <step>\n2. <step>…"` |
  | `image_url` | `image_url` |
  | `category` | `cuisine_type` |
  | `tags` | `[dish_type, flavor_profile, cuisine_type, hero_ingredient]` — lowercased, de-duped, non-empty |
  | `post_text` | `null` |

- **Dedup within the dataset:** drop exact duplicates keyed by `recipe_name + image_url`; genuine name-collisions keep distinct slugs (hash suffix). The slug is the cross-run dedup key at load time too.
- Skip malformed entries (missing `recipe_name` or `image_url`) and report a count.
- Write `data/normalized/recipes/recipes.json` (overwrites the old foodcourt file — source change is wholesale, confirmed).
- Pure, synchronous mapping functions exported for unit testing: `mapRecipe(raw)`, `slugify(name)`, `buildIngredientsText(arr)`, `buildInstructionsText(arr)`.
- npm script: `parse:recipes` (mirrors existing parser script conventions).

### 2. Loader — `apps/pipeline/src/loaders/recipes.js` (EXTEND, don't duplicate)

- The existing loader already inserts the normalized shape with `ON CONFLICT (slug) DO NOTHING` — reuse it (DRY).
- Add a `--fresh` flag (and `LOAD_FRESH=1` env equivalent) that runs `TRUNCATE recipes RESTART IDENTITY` before loading. This satisfies "clear the table" for the one-time cutover.
- Add npm script `load:recipes:fresh` = clear + load; keep `load:recipes` as the incremental (idempotent) load used while translation is still running.
- **Idempotency:** because translation is in progress, `load:recipes` can be re-run as new chunks land; `ON CONFLICT (slug)` skips already-loaded recipes.

### 3. Repository — `apps/automation/src/strategies/recipes/recipes.repository.ts` (NEW)

Mirror `PromptsRepository`. Inject the pg `DB_POOL`.

- `getNext(): Promise<RecipeRow | null>` —
  ```sql
  SELECT id, title, image_url, category, tags, ingredients, instructions
  FROM recipes
  WHERE NOT (posted ? 'TELEGRAM')
  ORDER BY created_at
  LIMIT 1
  ```
  (Deterministic oldest-first ordering; predictable for tests.)
- `markPosted(id: string): Promise<void>` —
  ```sql
  UPDATE recipes
  SET posted = posted || jsonb_build_object('TELEGRAM', to_jsonb(now()))
  WHERE id = $1
  ```

`RecipeRow` type: `{ id, title, image_url, category, tags: string[], ingredients: string|null, instructions: string|null }`.

### 4. Strategy — `apps/automation/src/strategies/recipes/recipes.strategy.ts` (REWRITE)

- Keep `readonly type = 'recipes'` and `onModuleInit() → registry.register(this)`.
- Implement a custom `execute(channelId, params)` (same pattern as `Ai0PromptsStrategy`), **not** the fetch/generate pipeline — so it can mark the DB row posted and control the photo+reply layout.
- Steps:
  1. `row = await this.repo.getNext()`. If `null` → log "no unposted recipes" and return (run recorded as ok/skipped by the scheduler).
  2. Build **caption** (≤ 1024 visible chars):
     - `header = <b>${title}</b>`
     - `meta = 🍽️ ${category}` (servings dropped — see "servings note" below)
     - `📝 Інгредієнти:` + ingredient lines (already a text block in `row.ingredients`), trimmed to fit 1024 via the existing `fitIngredients`-style budget helper.
  3. Build **replyText** = `👨‍🍳 Приготування:\n` + `row.instructions` (Telegram message limit 4096; if instructions exceed it, truncate on a step boundary and append `…`).
  4. Download `row.image_url` → `Buffer` (reuse the image-download helper the `ai0-prompts` strategy uses; on download failure, log and **skip without marking posted** so it's retried next run).
  5. `await this.publisher.publishPrompt({ imageBuffer, caption, replyText }, { id: channelId })`.
  6. `await this.repo.markPosted(row.id)`.
- `getSkills()` returns `[]` (no AI involved) — or is removed if the interface allows; keep returning `[]` for interface compatibility.
- Remove the `ClaudeAgent`, `PostValidator`, `MealDbFetcher` dependencies.

**Servings note:** the current `recipes` table has no `servings` column and the parser maps it into neither a column nor tags. Decision: **drop servings from the post** (meta = `🍽️ ${category}`). If we later want it, it can ride in `tags` or a migration — out of scope here.

### 5. Retire TheMealDB

- Delete `apps/automation/src/workflows/recipes/fetchers/mealdb.fetcher.ts` and the now-unused `workflows/recipes/types.ts` (verify no other importers first; if shared, leave the types and only drop the fetcher).
- Remove `MealDbFetcher` from the recipes module providers.

### 6. "Recheck existing loaders" — audit deliverable

A read-only audit of all 8 loaders (`recipes, prompts, daytoday, facts, pdr, tg-posts, treatfield, assets`): for each, confirm it (a) runs, (b) targets the documented table, (c) dedups via its stated conflict key. Fix only clear bugs found; report findings in the plan's final notes. No behavior changes beyond fixes.

## Error handling

- Parser: skip + count malformed recipes; never throw on a single bad entry.
- Loader: batched insert (existing `lib/loader.js`), `ON CONFLICT DO NOTHING`; `--fresh` truncate wrapped so a failed load doesn't leave the table empty (truncate + load in one transaction, or truncate only after the normalized file is confirmed non-empty).
- Strategy: image download failure → skip this run without marking posted (auto-retry next cron). Publish failure → propagates to the scheduler (recorded as `error`); the row stays unposted. `ChannelPausedError` from the publisher is already handled by the scheduler as `skipped`.

## Testing (cost-safe — no Claude, no Telegram, no network)

- **Parser unit tests** (`parsers/recipes-epicure.test.js` via the repo's node:test convention): mapping, slugify, slug-collision hash suffix, ingredient/instruction text building, malformed-entry skipping, dataset dedup. Fixtures only.
- **Loader test:** against local Postgres with a tiny fixture + `LOAD_LIMIT`; assert row count and that re-running is idempotent (no duplicate slugs). Verify `--fresh` truncates.
- **Repository test:** `getNext` returns oldest unposted; `markPosted` flips it so the next `getNext` skips it. Local Postgres.
- **Strategy unit test:** mock `RecipesRepository` + `TelegramPublisher`; assert caption ≤ 1024, reply carries instructions, `publishPrompt` called once, `markPosted` called with the row id, and that an image-download failure skips `markPosted`.
- **Standing cost rule:** the `recipes` strategy remains **unbound / automation not running** during local development, so no live publishes occur. Tests never hit real Claude/Telegram.

## Out of scope

- Prompt imports (separate spec).
- A `servings` column / migration.
- Any change to the `recipes` table schema (none needed).
- Translating recipes (done by the separate agent).
- Dashboard UI for browsing recipes.
