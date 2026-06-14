# Recipe Carousel Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `recipe-carousel` content strategy that renders a Telegram-published recipe into 3 slides, hosts them, publishes them as an IG/FB/Threads carousel, marks per-destination dedup, and deletes the hosted slides.

**Architecture:** A new Meta-only `RecipeCarouselStrategy` (`type='recipe-carousel'`) orchestrates the three finished sub-projects (renderer, hosting, carousel publishers) plus the shared recipe pool. A new additive `RecipesRepository.getNextForCarousel` selects Telegram-published, not-yet-on-this-destination recipes. A pure helper maps a row → `CarouselRecipe` and builds the caption. No migration; the Telegram recipes strategy is untouched.

**Tech Stack:** NestJS 10, pg, `node:test` via `npm test` (run from `apps/automation`).

---

## Context for the implementer

This is **sub-project 4 of 5** of the recipe image-carousel feature. Sub-projects 1
(renderer), 2 (hosting), 3 (carousel publishers) are already merged into `develop`. Read
these to match patterns and signatures exactly:

- `apps/automation/src/strategies/recipes/recipes.strategy.ts` — the Telegram recipe strategy (the Meta branch shows the markPosted / `isPermanentMetaMediaError` pattern). **Do not modify it.**
- `apps/automation/src/strategies/recipes/recipes.repository.ts` — `RecipesRepository`, `RecipeRow`, `getNext`, `markPosted`. Pool injected via `@Inject(DB_POOL)`.
- `apps/automation/src/strategies/recipes/recipes-strategy.module.ts` — provider module (you will add an export).
- `apps/automation/src/common/carousel/recipe-carousel-renderer.service.ts` — `RecipeCarouselRendererService`, `CarouselRecipe`, `render(recipe, imageBuffer, opts?) → Buffer[]`.
- `apps/automation/src/common/carousel/carousel-text.ts` — `parseNum(s: string|null): number|null`.
- `apps/automation/src/publishers/hosting/slide-hosting.service.ts` — abstract `SlideHostingService`: `available()`, `upload(slides, keyPrefix) → HostedSlide[]`, `delete(paths)`. (`@Global` PublishersModule export.)
- `apps/automation/src/publishers/publisher-dispatcher.service.ts` — `PublisherDispatcher.publishCarousel(platform, payload, imageUrls, target)`.
- `apps/automation/src/publishers/meta-graph.util.ts` — `isPermanentMetaMediaError(message)`.
- `apps/automation/src/common/processors/image-resolver.service.ts` — `ImageResolverService.download(url): Promise<Buffer|null>` (returns null on failure; `@Global`).
- `apps/automation/src/common/content-strategy/content-strategy.interface.ts` — `ContentStrategy`, `StrategyParams`, `StrategyFetchResult`, `StrategyPost`.
- `apps/automation/src/common/content-strategy/publish-destination.ts` — `PublishDestination` ({ platform, targetId, token?, metaAccountId, postedKey, throttleKey }).
- `apps/automation/src/strategies/recipes/recipes.strategy.test.ts` — the test style to mirror (plain object mocks, `new Strategy(...)` with positional args cast `as any`).
- `apps/automation/src/app.module.ts` — strategy modules are imported and listed in the `imports` array.

Rules:
- Tests run with `npm test` **from `apps/automation`** (`tsx --test "src/**/*.test.ts"`). Running tsx from the repo root drops `experimentalDecorators` and breaks decorator files — always use `cd apps/automation && npm test`.
- No live network / Supabase / Claude / Graph calls in tests; mock every collaborator. No service restart.
- No new dependency, no DB migration. Do NOT modify the Telegram recipes strategy or any publisher/renderer/hosting code.

Spec: `docs/superpowers/specs/2026-06-14-recipe-carousel-strategy-design.md`.

## File Structure

- `apps/automation/src/strategies/recipes/recipes.repository.ts` — add `getNextForCarousel`. Modify.
- `apps/automation/src/strategies/recipes/recipes.repository.carousel.test.ts` — fake-pool test for the new query. New.
- `apps/automation/src/strategies/recipes/recipes-strategy.module.ts` — export `RecipesRepository`. Modify.
- `apps/automation/src/strategies/recipe-carousel/recipe-carousel.map.ts` — pure mapping + caption helpers. New.
- `apps/automation/src/strategies/recipe-carousel/recipe-carousel.map.test.ts` — helper tests. New.
- `apps/automation/src/strategies/recipe-carousel/recipe-carousel.strategy.ts` — the strategy. New.
- `apps/automation/src/strategies/recipe-carousel/recipe-carousel.strategy.test.ts` — strategy tests. New.
- `apps/automation/src/strategies/recipe-carousel/recipe-carousel-strategy.module.ts` — DI module. New.
- `apps/automation/src/app.module.ts` — register the module. Modify.

---

## Task 1: `getNextForCarousel` + export the repository

**Files:**
- Modify: `apps/automation/src/strategies/recipes/recipes.repository.ts`
- Test: `apps/automation/src/strategies/recipes/recipes.repository.carousel.test.ts`
- Modify: `apps/automation/src/strategies/recipes/recipes-strategy.module.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/strategies/recipes/recipes.repository.carousel.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecipesRepository } from './recipes.repository';

function fakePool(rows: any[]) {
  const captured: { sql?: string; params?: any[] } = {};
  const pool = {
    query: async (sql: string, params: any[]) => { captured.sql = sql; captured.params = params; return { rows }; },
  };
  return { pool, captured };
}

test('getNextForCarousel filters Telegram-published, per-destination, with nutrition', async () => {
  const row = { id: 'r1' };
  const { pool, captured } = fakePool([row]);
  const repo = new RecipesRepository(pool as any);

  const result = await repo.getNextForCarousel('IG:acc1');

  assert.equal(result, row);
  assert.deepEqual(captured.params, ['IG:acc1']);
  assert.match(captured.sql!, /posted \? 'TELEGRAM'/);
  assert.match(captured.sql!, /NOT \(posted \? \$1\)/);
  assert.match(captured.sql!, /kcal IS NOT NULL/);
});

test('getNextForCarousel returns null when no row', async () => {
  const { pool } = fakePool([]);
  const repo = new RecipesRepository(pool as any);
  assert.equal(await repo.getNextForCarousel('IG:acc1'), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/automation`):
```bash
npx tsx --test src/strategies/recipes/recipes.repository.carousel.test.ts
```
Expected: FAIL — `getNextForCarousel` is not a function.

- [ ] **Step 3: Add the method**

In `apps/automation/src/strategies/recipes/recipes.repository.ts`, add this method to the `RecipesRepository` class (after `getNext`):

```ts
  /**
   * Next recipe for a carousel destination: already published to Telegram (so it
   * is translated), NOT yet posted to this Meta destination, not a skip sentinel,
   * and carries nutrition. Oldest-first. The Telegram strategy owns translation;
   * the carousel never calls Claude.
   */
  async getNextForCarousel(postedKey: string): Promise<RecipeRow | null> {
    const { rows } = await this.pool.query<RecipeRow>(
      `SELECT id, title, image_url, category, ingredients, instructions,
              title_uk, ingredients_uk, instructions_uk,
              telegraph_url, telegraph_path,
              kcal, protein_g, fat_g, carbs_g, serving_size_g
       FROM recipes
       WHERE (posted ? 'TELEGRAM')
         AND NOT (posted ? $1)
         AND title_uk IS DISTINCT FROM ''
         AND kcal IS NOT NULL
       ORDER BY created_at
       LIMIT 1`,
      [postedKey],
    );
    return rows[0] ?? null;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `apps/automation`):
```bash
npx tsx --test src/strategies/recipes/recipes.repository.carousel.test.ts
```
Expected: PASS — 2 tests.

- [ ] **Step 5: Export the repository for the carousel module**

In `apps/automation/src/strategies/recipes/recipes-strategy.module.ts`, add `RecipesRepository` to `exports`. The file becomes:

```ts
import { Module } from '@nestjs/common';
import { RecipesStrategy }   from './recipes.strategy';
import { RecipesRepository } from './recipes.repository';

@Module({
  providers: [RecipesStrategy, RecipesRepository],
  exports:   [RecipesStrategy, RecipesRepository],
})
export class RecipesStrategyModule {}
```

- [ ] **Step 6: Commit**

```bash
git add apps/automation/src/strategies/recipes/recipes.repository.ts apps/automation/src/strategies/recipes/recipes.repository.carousel.test.ts apps/automation/src/strategies/recipes/recipes-strategy.module.ts
git commit -m "feat(carousel): RecipesRepository.getNextForCarousel + export repo"
```

---

## Task 2: Pure mapping + caption helpers

**Files:**
- Create: `apps/automation/src/strategies/recipe-carousel/recipe-carousel.map.ts`
- Test: `apps/automation/src/strategies/recipe-carousel/recipe-carousel.map.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/strategies/recipe-carousel/recipe-carousel.map.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCarouselRecipe, buildCarouselCaption, macrosLine } from './recipe-carousel.map';

function row(over = {}) {
  return {
    id: 'r1', title: 'Pommes Anna', image_url: 'https://x/i.jpg', category: 'Французька',
    ingredients: null, instructions: null,
    title_uk: 'Пом Анна', ingredients_uk: 'Картопля — 1 кг', instructions_uk: '1. Розтопіть масло.',
    telegraph_url: null, telegraph_path: null,
    kcal: '85', protein_g: '4', fat_g: '1', carbs_g: '15', serving_size_g: '258',
    ...over,
  } as any;
}

test('toCarouselRecipe maps fields and parses numeric strings', () => {
  const r = toCarouselRecipe(row());
  assert.equal(r.titleUk, 'Пом Анна');
  assert.equal(r.category, 'Французька');
  assert.equal(r.kcal, 85);
  assert.equal(r.proteinG, 4);
  assert.equal(r.ingredientsUk, 'Картопля — 1 кг');
  assert.equal(r.instructionsUk, '1. Розтопіть масло.');
});

test('toCarouselRecipe yields null for empty/missing numerics and uk fields', () => {
  const r = toCarouselRecipe(row({ kcal: '', protein_g: null, title_uk: null, ingredients_uk: null }));
  assert.equal(r.kcal, null);
  assert.equal(r.proteinG, null);
  assert.equal(r.titleUk, '');
  assert.equal(r.ingredientsUk, '');
});

test('macrosLine formats present macros and rounds kcal', () => {
  assert.equal(macrosLine(row({ kcal: '84.55' })), '🔥 85 ккал · Б 4 · Ж 1 · В 15 (на порцію)');
  assert.equal(macrosLine(row({ kcal: '', protein_g: null, fat_g: null, carbs_g: null })), '');
});

test('buildCarouselCaption includes title, cuisine, macros, and a CTA', () => {
  const c = buildCarouselCaption(row());
  assert.match(c, /Пом Анна/);
  assert.match(c, /🍽️ Французька/);
  assert.match(c, /🔥 85 ккал/);
  assert.match(c, /гортай/);
});

test('buildCarouselCaption omits cuisine and macros when absent', () => {
  const c = buildCarouselCaption(row({ category: null, kcal: '', protein_g: null, fat_g: null, carbs_g: null }));
  assert.doesNotMatch(c, /🍽️/);
  assert.doesNotMatch(c, /🔥/);
  assert.match(c, /Пом Анна/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/automation`):
```bash
npx tsx --test src/strategies/recipe-carousel/recipe-carousel.map.test.ts
```
Expected: FAIL — cannot find module `./recipe-carousel.map`.

- [ ] **Step 3: Write the implementation**

Create `apps/automation/src/strategies/recipe-carousel/recipe-carousel.map.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `apps/automation`):
```bash
npx tsx --test src/strategies/recipe-carousel/recipe-carousel.map.test.ts
```
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/strategies/recipe-carousel/recipe-carousel.map.ts apps/automation/src/strategies/recipe-carousel/recipe-carousel.map.test.ts
git commit -m "feat(carousel): recipe-carousel row→CarouselRecipe + caption helpers"
```

---

## Task 3: `RecipeCarouselStrategy`

**Files:**
- Create: `apps/automation/src/strategies/recipe-carousel/recipe-carousel.strategy.ts`
- Test: `apps/automation/src/strategies/recipe-carousel/recipe-carousel.strategy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/strategies/recipe-carousel/recipe-carousel.strategy.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecipeCarouselStrategy } from './recipe-carousel.strategy';

function makeRow(over = {}) {
  return {
    id: 'r1', title: 'Pommes Anna', image_url: 'https://x/i.jpg', category: 'Французька',
    ingredients: null, instructions: null,
    title_uk: 'Пом Анна', ingredients_uk: 'Картопля', instructions_uk: '1. Розтопіть',
    telegraph_url: null, telegraph_path: null,
    kcal: '85', protein_g: '4', fat_g: '1', carbs_g: '15', serving_size_g: '258',
    ...over,
  };
}

const IG_DEST = {
  platform: 'instagram', targetId: 'IG1', token: 'tok',
  metaAccountId: 'acc1', postedKey: 'IG:acc1', throttleKey: 'meta:acc1',
} as any;

function build(over: any = {}) {
  const calls: any = { rendered: null, uploaded: null, published: null, posted: [], deleted: [], downloaded: 0 };
  const repo = {
    getNextForCarousel: async () => ('row' in over ? over.row : makeRow()),
    markPosted: async (id: string, key: string) => { calls.posted.push([id, key]); },
  };
  const renderer = {
    render: async (recipe: any) => { calls.rendered = recipe; return [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')]; },
  };
  const hosting = {
    available: async () => true,
    upload: async (slides: Buffer[], prefix: string) => {
      calls.uploaded = { count: slides.length, prefix };
      return [{ url: 'u1', path: 'p1' }, { url: 'u2', path: 'p2' }, { url: 'u3', path: 'p3' }];
    },
    delete: async (paths: string[]) => { calls.deleted = paths; },
  };
  const dispatcher = {
    publishCarousel: async (platform: string, payload: any, urls: string[], target: any) => {
      calls.published = { platform, payload, urls, target };
      if (over.publishError) throw new Error(over.publishError);
      return 'post-1';
    },
  };
  const images = { download: async () => { calls.downloaded++; return over.image === null ? null : Buffer.from('img'); } };
  const registry = { register() {} };
  const s = new RecipeCarouselStrategy(
    repo as any, renderer as any, hosting as any, dispatcher as any, images as any, registry as any,
  );
  return { s, calls };
}

test('happy path: render → upload → publishCarousel → markPosted → delete', async () => {
  const { s, calls } = build();
  await s.execute('', {}, IG_DEST);

  assert.equal(calls.rendered.titleUk, 'Пом Анна');
  assert.equal(calls.uploaded.count, 3);
  assert.equal(calls.uploaded.prefix, 'carousel/instagram/acc1/r1');
  assert.equal(calls.published.platform, 'instagram');
  assert.deepEqual(calls.published.urls, ['u1', 'u2', 'u3']);
  assert.equal(calls.published.target.id, 'IG1');
  assert.equal(calls.published.target.token, 'tok');
  assert.match(calls.published.payload.text, /Пом Анна/);
  assert.deepEqual(calls.published.payload.tags, ['Французька']);
  assert.deepEqual(calls.posted, [['r1', 'IG:acc1']]);
  assert.deepEqual(calls.deleted, ['p1', 'p2', 'p3']);
});

test('no eligible recipe: returns without rendering or publishing', async () => {
  const { s, calls } = build({ row: null });
  await s.execute('', {}, IG_DEST);
  assert.equal(calls.rendered, null);
  assert.equal(calls.published, null);
  assert.equal(calls.posted.length, 0);
});

test('telegram destination: returns without touching the repo', async () => {
  const { s, calls } = build();
  await s.execute('', {}, { platform: 'telegram', targetId: 'c', metaAccountId: null, postedKey: 'TELEGRAM', throttleKey: 'c' } as any);
  assert.equal(calls.rendered, null);
  assert.equal(calls.published, null);
});

test('image download fails: throws, no upload/publish/markPosted', async () => {
  const { s, calls } = build({ image: null });
  await assert.rejects(() => s.execute('', {}, IG_DEST), /image download failed/i);
  assert.equal(calls.uploaded, null);
  assert.equal(calls.published, null);
  assert.equal(calls.posted.length, 0);
});

test('transient publish error: no markPosted, slides deleted, throws', async () => {
  const { s, calls } = build({ publishError: 'rate limited' });
  await assert.rejects(() => s.execute('', {}, IG_DEST), /Carousel publish/);
  assert.equal(calls.posted.length, 0);
  assert.deepEqual(calls.deleted, ['p1', 'p2', 'p3']);
});

test('permanent media error: markPosted (advance queue), slides deleted, throws', async () => {
  const { s, calls } = build({ publishError: 'Unsupported aspect ratio' });
  await assert.rejects(() => s.execute('', {}, IG_DEST), /Carousel publish/);
  assert.deepEqual(calls.posted, [['r1', 'IG:acc1']]);
  assert.deepEqual(calls.deleted, ['p1', 'p2', 'p3']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/automation`):
```bash
npx tsx --test src/strategies/recipe-carousel/recipe-carousel.strategy.test.ts
```
Expected: FAIL — cannot find module `./recipe-carousel.strategy`.

- [ ] **Step 3: Write the implementation**

Create `apps/automation/src/strategies/recipe-carousel/recipe-carousel.strategy.ts`:

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ContentStrategyRegistry } from '../../common/content-strategy/content-strategy.registry';
import { RecipeCarouselRendererService } from '../../common/carousel/recipe-carousel-renderer.service';
import { SlideHostingService } from '../../publishers/hosting/slide-hosting.service';
import { PublisherDispatcher } from '../../publishers/publisher-dispatcher.service';
import { ImageResolverService } from '../../common/processors/image-resolver.service';
import { isPermanentMetaMediaError } from '../../publishers/meta-graph.util';
import { RecipesRepository } from '../recipes/recipes.repository';
import { toCarouselRecipe, buildCarouselCaption } from './recipe-carousel.map';
import type { PublishDestination } from '../../common/content-strategy/publish-destination';
import {
  ContentStrategy, StrategyFetchResult, StrategyPost, StrategyParams,
} from '../../common/content-strategy/content-strategy.interface';
import { Skill } from '../../common/ai/skills/skill.interface';

/**
 * recipe-carousel — Meta-only. Renders a Telegram-published recipe into 3 slides,
 * hosts them, publishes an IG/Threads carousel or FB album, records per-destination
 * dedup, and deletes the hosted slides. The Telegram recipes strategy owns
 * translation; this strategy only consumes already-translated rows.
 */
@Injectable()
export class RecipeCarouselStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(RecipeCarouselStrategy.name);
  readonly type = 'recipe-carousel';

  constructor(
    private readonly repo:       RecipesRepository,
    private readonly renderer:   RecipeCarouselRendererService,
    private readonly hosting:    SlideHostingService,
    private readonly dispatcher: PublisherDispatcher,
    private readonly images:     ImageResolverService,
    private readonly registry:   ContentStrategyRegistry,
  ) {}

  onModuleInit() { this.registry.register(this); }

  getSkills(_params: StrategyParams): Skill[] { return []; }
  async fetch(_params: StrategyParams, _channelId: string): Promise<StrategyFetchResult | null> { return null; }
  async generate(_data: StrategyFetchResult, _params: StrategyParams): Promise<StrategyPost | 'SKIP_POST' | null> { return null; }

  async execute(_channelId: string, _params: StrategyParams, dest?: PublishDestination): Promise<void> {
    if (!dest || dest.platform === 'telegram') {
      this.logger.warn('recipe-carousel is Meta-only — no Telegram destination');
      return;
    }
    if (!dest.token) {
      this.logger.error(`Carousel skipped: token missing for ${dest.platform}`);
      return;
    }

    const row = await this.repo.getNextForCarousel(dest.postedKey);
    if (!row) { this.logger.debug('No carousel-eligible recipes'); return; }

    const recipe  = toCarouselRecipe(row);
    const caption = buildCarouselCaption(row);

    const imageBuffer = await this.images.download(row.image_url);
    if (!imageBuffer) throw new Error(`Carousel image download failed (${row.id})`);

    const slides = await this.renderer.render(recipe, imageBuffer);
    const keyPrefix = `carousel/${dest.platform}/${dest.metaAccountId}/${row.id}`;
    const hosted = await this.hosting.upload(slides, keyPrefix);

    try {
      const id = await this.dispatcher.publishCarousel(
        dest.platform,
        { text: caption, tags: row.category ? [row.category] : [], source: '' },
        hosted.map(h => h.url),
        { id: dest.targetId, token: dest.token },
      );
      await this.repo.markPosted(row.id, dest.postedKey);
      this.logger.debug(`Published carousel ${row.id} → ${dest.platform} (${id})`);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      this.logger.error(`Carousel publish failed (${row.id} → ${dest.platform}): ${msg}`);
      // Permanent media errors never succeed for this image — advance the queue.
      if (isPermanentMetaMediaError(msg)) {
        try { await this.repo.markPosted(row.id, dest.postedKey); } catch { /* best-effort */ }
      }
      throw new Error(`Carousel publish (${dest.platform}): ${msg}`);
    } finally {
      // Slides are ingested by Meta during container/photo creation; drop our copies.
      await this.hosting.delete(hosted.map(h => h.path));
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `apps/automation`):
```bash
npx tsx --test src/strategies/recipe-carousel/recipe-carousel.strategy.test.ts
```
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/strategies/recipe-carousel/recipe-carousel.strategy.ts apps/automation/src/strategies/recipe-carousel/recipe-carousel.strategy.test.ts
git commit -m "feat(carousel): RecipeCarouselStrategy — render→host→publish→dedup→cleanup"
```

---

## Task 4: Module wiring + full verification

**Files:**
- Create: `apps/automation/src/strategies/recipe-carousel/recipe-carousel-strategy.module.ts`
- Modify: `apps/automation/src/app.module.ts`

- [ ] **Step 1: Create the module**

Create `apps/automation/src/strategies/recipe-carousel/recipe-carousel-strategy.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { RecipeCarouselStrategy } from './recipe-carousel.strategy';
import { RecipesStrategyModule } from '../recipes/recipes-strategy.module';

@Module({
  imports:   [RecipesStrategyModule],   // provides RecipesRepository (exported)
  providers: [RecipeCarouselStrategy],
})
export class RecipeCarouselStrategyModule {}
```

(`RecipeCarouselRendererService`, `SlideHostingService`, `PublisherDispatcher`,
`ImageResolverService`, and `ContentStrategyRegistry` come from `@Global` modules, so no
extra imports are required.)

- [ ] **Step 2: Register the module in AppModule**

In `apps/automation/src/app.module.ts`, add the import next to the other strategy module imports:

```ts
import { RecipeCarouselStrategyModule } from './strategies/recipe-carousel/recipe-carousel-strategy.module';
```

and add `RecipeCarouselStrategyModule` to the `imports` array (next to `RecipesStrategyModule`).

- [ ] **Step 3: Typecheck the whole app**

Run (from `apps/automation`):
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors referencing `recipe-carousel` or `recipes.repository`.

- [ ] **Step 4: Run the full suite**

Run (from `apps/automation`):
```bash
npm test
```
Expected: all tests pass, including the new ones (repo carousel 2, map 5, strategy 6). No failures.

- [ ] **Step 5: Build to confirm the module graph compiles**

Run (from `apps/automation`):
```bash
npm run build
```
Expected: `nest build` completes with no errors (confirms `RecipeCarouselStrategy` constructs — all its deps resolve through the imported/global modules).

- [ ] **Step 6: Commit**

```bash
git add apps/automation/src/strategies/recipe-carousel/recipe-carousel-strategy.module.ts apps/automation/src/app.module.ts
git commit -m "feat(carousel): register RecipeCarouselStrategyModule in AppModule"
```

---

## Done criteria

- A binding with `type='recipe-carousel'` + a Meta platform + meta_account renders, hosts, publishes a carousel/album, marks `<platform>:<account>` dedup, and deletes the hosted slides.
- `getNextForCarousel` selects only Telegram-published, not-yet-on-this-destination, nutrition-bearing recipes; the carousel never calls Claude.
- Transient errors retry (no dedup mark); permanent media errors advance the queue; cleanup always runs.
- All tests pass via `cd apps/automation && npm test`; `npm run build` succeeds; the Telegram recipes strategy, publishers, renderer, and hosting are untouched; no migration, no new dependency.
- Sub-project 5 (TikTok) is the only remaining piece.
