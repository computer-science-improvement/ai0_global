# Recipes DB Refresh — Design

**Date:** 2026-05-26
**Status:** Approved (brainstorming)
**Scope:** Recipes only. The two prompt imports (awesome-nanobanana-pro, awesome-seedance) are a **separate, later spec** that will extend the `prompts` table with stored prompt text + a `media_type` column and add a new posting strategy.

## Goal

Switch the recipe content source from TheMealDB's live API to our own Postgres `recipes` table, seeded from the **English** epicure dataset. The `recipes` strategy translates each recipe to Ukrainian via Claude **lazily at post time** and **caches the translation back into the DB**, so each recipe is translated at most once (a publish retry never re-pays for translation).

## Context (current state)

- **Existing `recipes` strategy** (`apps/automation/src/strategies/recipes/recipes.strategy.ts`) fetches a random recipe from TheMealDB (`MealDbFetcher`) and uses Claude to produce a Ukrainian description. It **ignores the `recipes` table** entirely.
- **`recipes` table** (`database/init.sql`): `id, title, slug, url, description, ingredients TEXT, instructions TEXT, image_url, category, tags TEXT[], post_text, posted JSONB, created_at`. Unique index on `slug`. `posted` is a JSONB map like `{TELEGRAM: "<ts>"}`.
- **Existing recipes loader** (`apps/pipeline/src/loaders/recipes.js`) loads `data/normalized/recipes/recipes.json` into `recipes` with `ON CONFLICT (slug) DO NOTHING`.
- **Source data:** `apps/pipeline/src/raw-data/raw-data/recipes/recipes_*.json` — 26 chunks, **English**, epicure schema. (The `recipes-ua/` pre-translation experiment is abandoned; translation happens in-strategy via Claude.)
- **Publisher:** `TelegramPublisher.publishPrompt({ imageBuffer, caption, replyText? }, target)` sends a photo+caption, then an optional reply with `replyText`. Requires `imageBuffer: Buffer`. This is the exact mechanism the recipe post needs.

### Source recipe shape (recipes/, English)

```json
{
  "recipe_name": "Classic Pommes Anna",
  "image_url": "https://storage.googleapis.com/epicure-generated-images-kaikaku-bi/generated_image_...jpg",
  "dish_type": "main",
  "flavor_profile": "savory",
  "cuisine_type": "French",
  "hero_ingredient": "Potato",
  "visual_description": "A golden-brown Pommes Anna ...",
  "ingredients": [ { "name": "Yukon Gold potatoes", "quantity": "1 kg" }, ... ],
  "instructions": [ "Melt butter in a small saucepan ...", ... ]
}
```

## Decisions (locked during brainstorming)

1. **Replace** the existing `recipes` strategy to read from the DB (keep the type name `recipes`; channel bindings unchanged). TheMealDB fetcher is retired.
2. **Source = English `recipes/`.** Translation is done by Claude, not pre-supplied.
3. **Load all** recipes, dedup on `slug`.
4. **Lazy translation at post time, cached to the DB.** One Claude call the first time a recipe is posted; the result is stored in new `*_uk` columns and reused on retry.
5. **Store structured translated fields:** `title_uk`, `ingredients_uk`, `instructions_uk` (+ `translated_at`).
6. **Post layout** = photo + caption (title + meta + ingredients, all Ukrainian) **then a follow-up reply** with the full numbered Ukrainian instructions.

## Architecture / data flow

```
raw-data/recipes/recipes_*.json   (English, epicure schema)
        │  NEW parser: parsers/recipes-epicure.js  (map + slug-dedup, keeps English text)
        ▼
data/normalized/recipes/recipes.json   (English structured)
        │  loader: loaders/recipes.js  (+ --fresh TRUNCATE option; ON CONFLICT(slug) DO NOTHING)
        ▼
Postgres: recipes table  (English source cols + empty *_uk cols)
        │
        │  recipes strategy execute():
        │    getNext() → if title_uk IS NULL: Claude translate → saveTranslation()
        │    → render caption+reply from *_uk → download image → publishPrompt → markPosted
        ▼
Telegram: photo+caption (UA ingredients) + reply (UA instructions)   |   recipes.posted = {TELEGRAM: ts}
```

## Components

### 1. Migration — `database/migrations/008_recipes_translation.sql` (NEW)

```sql
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

Also mirror the four columns into the `recipes` table definition in `database/init.sql` so fresh installs match.

### 2. Parser — `apps/pipeline/src/parsers/recipes-epicure.js` (NEW)

- Read every `recipes/recipes_*.json` chunk (ignore `index.json`).
- Flatten each chunk's `recipes[]`.
- Map each recipe to the normalized shape (English; reuses existing source columns):

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

- **Dedup within the dataset:** drop exact duplicates keyed by `recipe_name + image_url`; genuine name-collisions keep distinct slugs (hash suffix). `slug` is the cross-run dedup key at load time too.
- Skip malformed entries (missing `recipe_name` or `image_url`) and report a count.
- Write `data/normalized/recipes/recipes.json` (overwrites the old foodcourt file — source change is wholesale, confirmed).
- Pure, exported, unit-testable functions: `mapRecipe(raw)`, `slugify(name)`, `buildIngredientsText(arr)`, `buildInstructionsText(arr)`.
- npm script: `parse:recipes`.

### 3. Loader — `apps/pipeline/src/loaders/recipes.js` (EXTEND, don't duplicate)

- Reuse the existing loader (it already inserts the normalized shape with `ON CONFLICT (slug) DO NOTHING`).
- Add a `--fresh` flag (and `LOAD_FRESH=1` env) that runs `TRUNCATE recipes RESTART IDENTITY` before loading — the one-time clear/cutover.
- npm scripts: `load:recipes:fresh` (clear + load) and existing `load:recipes` (incremental, idempotent).
- The `*_uk` columns are **not** written by the loader — they start NULL and are filled by the strategy.

### 4. Translation prompt — `apps/automation/src/common/ai/prompts/recipe-translate.prompts.ts` (NEW)

- A system prompt that localizes an English recipe into the Ukrainian recipes-channel voice (compose with `RECIPES_CHANNEL_SKILL` tone), returning **strict JSON**:
  ```json
  { "title_uk": "...", "ingredients_uk": "<lines>", "instructions_uk": "<numbered lines>" }
  ```
  - `ingredients_uk`: one `"<назва> — <кількість>"` per line, units converted naturally (kg→кг, g→г, ml→мл).
  - `instructions_uk`: numbered steps, faithful to the English, natural Ukrainian.
- `buildRecipeTranslateUserMessage(row)` assembles the English `title`, `ingredients`, `instructions`, `category` into the user turn.
- May emit `SKIP_POST` if the recipe is unusable (mirrors existing prompt convention).

### 5. Repository — `apps/automation/src/strategies/recipes/recipes.repository.ts` (NEW)

Mirror `PromptsRepository`. Inject `DB_POOL`.

- `getNext(): Promise<RecipeRow | null>`
  ```sql
  SELECT id, title, image_url, category, ingredients, instructions,
         title_uk, ingredients_uk, instructions_uk
  FROM recipes
  WHERE NOT (posted ? 'TELEGRAM')
  ORDER BY created_at
  LIMIT 1
  ```
- `saveTranslation(id, { titleUk, ingredientsUk, instructionsUk }): Promise<void>`
  ```sql
  UPDATE recipes
  SET title_uk = $2, ingredients_uk = $3, instructions_uk = $4, translated_at = now()
  WHERE id = $1
  ```
- `markPosted(id): Promise<void>`
  ```sql
  UPDATE recipes
  SET posted = posted || jsonb_build_object('TELEGRAM', to_jsonb(now()))
  WHERE id = $1
  ```

`RecipeRow`: `{ id, title, image_url, category, ingredients, instructions, title_uk, ingredients_uk, instructions_uk }` (the `*_uk` fields are `string | null`).

### 6. Strategy — `apps/automation/src/strategies/recipes/recipes.strategy.ts` (REWRITE)

- Keep `readonly type = 'recipes'` and `onModuleInit() → registry.register(this)`.
- Implement custom `execute(channelId, params)` (same pattern as `Ai0PromptsStrategy`):
  1. `row = await this.repo.getNext()`. If `null` → log "no unposted recipes" and return.
  2. **Translate if needed:** if `row.title_uk` is null:
     - If `!this.claude.available` → log + return (don't mark posted; retried next run).
     - Call Claude with the translation prompt; parse JSON `{ title_uk, ingredients_uk, instructions_uk }`.
     - If `SKIP_POST` / invalid JSON → log + return without marking posted (retried later). (Persistent bad rows are rare; acceptable to retry — no infinite cost loop because translation is the only Claude call and getNext is oldest-first; if a row is permanently bad it will block the queue — see "Risk" below.)
     - `await this.repo.saveTranslation(row.id, …)` and use the parsed values for this run.
     - Else (already translated) use the stored `*_uk` values.
  3. Build **caption** (≤ 1024 visible chars): `<b>${title_uk}</b>` + `🍽️ ${category}` + `📝 Інгредієнти:` + ingredient lines from `ingredients_uk`, trimmed to fit 1024 via a `fitText` budget helper.
  4. Build **replyText** = `👨‍🍳 Приготування:\n` + `instructions_uk` (truncate on a step boundary + `…` if > 4096).
  5. Download `row.image_url` → `Buffer` (reuse the `ai0-prompts` image-download helper). On failure → log + return without marking posted (retried; translation already cached so no re-pay).
  6. `await this.publisher.publishPrompt({ imageBuffer, caption, replyText }, { id: channelId })`.
  7. `await this.repo.markPosted(row.id)`.
- Keep `ClaudeAgent` + `PostValidator` deps (used for translation). Remove `MealDbFetcher`.
- `getSkills()` returns `[RECIPES_CHANNEL_SKILL]` (tone reference for translation) — or `[]` if not consumed; keep for interface compatibility.

### 7. Retire TheMealDB

- Delete `apps/automation/src/workflows/recipes/fetchers/mealdb.fetcher.ts` (verify no other importers first).
- Drop `MealDbFetcher` from the recipes module providers; keep `workflows/recipes/types.ts` only if still imported elsewhere.

### 8. "Recheck existing loaders" — audit deliverable

Read-only audit of all 8 loaders (`recipes, prompts, daytoday, facts, pdr, tg-posts, treatfield, assets`): confirm each runs, targets the documented table, and dedups via its stated conflict key. Fix only clear bugs found; report findings in the plan's final notes.

## Error handling & risks

- **Parser:** skip + count malformed recipes; never throw on one bad entry.
- **Loader:** batched insert + `ON CONFLICT DO NOTHING`; `--fresh` truncate guarded so a failed/empty normalized file never leaves the table empty (truncate only after confirming the normalized file is non-empty).
- **Strategy:** translation/image/publish failures return **without marking posted** → retried next cron. `ChannelPausedError` is already handled by the scheduler as `skipped`.
- **Risk — poison row:** because `getNext` is oldest-first and a permanently-untranslatable row never gets marked posted, it could block the queue (re-translated every run = recurring cost). Mitigation: on `SKIP_POST`/invalid JSON, write a sentinel so it's skipped — store `title_uk = ''` (empty) + `translated_at = now()` and treat empty `title_uk` as "skip this row" in `getNext` (`WHERE NOT (posted ? 'TELEGRAM') AND title_uk IS DISTINCT FROM ''`). This caps translation to one attempt per row.

## Testing (cost-safe — Claude/Telegram mocked, no network)

- **Parser unit tests:** mapping, slugify, slug-collision hash suffix, ingredient/instruction text building, malformed-entry skipping, dataset dedup. Fixtures only.
- **Loader test:** local Postgres + tiny fixture + `LOAD_LIMIT`; assert row count, idempotent re-run (no dup slugs), `--fresh` truncates.
- **Migration test:** apply `008` to local DB; assert the four columns + partial index exist.
- **Repository test:** `getNext` oldest-unposted; `saveTranslation` populates `*_uk` + `translated_at`; `markPosted` flips `posted`; poison-sentinel row (`title_uk = ''`) is skipped by `getNext`.
- **Strategy unit test (mocked Claude + publisher):**
  - untranslated row → Claude called once, `saveTranslation` called, caption ≤ 1024, reply carries instructions, `publishPrompt` called once, `markPosted` called.
  - **already-translated row → Claude NOT called** (cache reuse).
  - image-download failure → no `markPosted`.
  - `SKIP_POST` → sentinel saved, no publish, no `markPosted`.
- **Standing cost rule:** the `recipes` strategy stays **unbound / automation not running** during local development; tests never hit real Claude/Telegram.

## Out of scope

- Prompt imports (separate spec).
- A `servings` column (dropped from the post; no column today).
- Translating recipes outside the strategy (no batch step).
- Dashboard UI for browsing recipes.

---

## Loader audit (2026-05-26)

All 8 loaders parse (`node --check`) and their `ON CONFLICT` keys map to a real
unique constraint. No bugs found; no fixes required.

| Loader | Table | Conflict key | Backing unique constraint | Result |
|---|---|---|---|---|
| assets.js | assets | (data_source, title) | idx_assets_unique | PASS |
| daytoday.js | on_this_day | (month, day, slug) | idx_on_this_day_unique | PASS |
| daytoday.js | articles | (slug) | articles_slug_key (inline `slug … unique`) | PASS |
| daytoday.js | jokes | (content_hash) | idx_jokes_hash | PASS |
| facts.js | facts | (content_hash) | idx_facts_hash | PASS |
| pdr.js | pdr_questions | (question_id) | idx_pdr_questions_qid | PASS |
| prompts.js | prompts | (id) | prompts PK (id TEXT PRIMARY KEY) | PASS |
| recipes.js | recipes | (slug) | idx_recipes_slug | PASS |
| tg-posts.js | tg_posts | (content_hash) | idx_tg_posts_content_hash | PASS |
| treatfield.js | articles | (slug) | articles_slug_key | PASS |

Note: input paths under `data/normalized/**` depend on the corresponding parser
having run; that's data availability, not a loader defect.
