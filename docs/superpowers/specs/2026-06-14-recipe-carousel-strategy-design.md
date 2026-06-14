# Recipe Carousel Strategy (sub-project 4/5) — Design

**Status:** approved (brainstorming) — 2026-06-14
**Branch:** `feat/recipe-carousel-strategy` (off `develop`, which already has sub-projects 1+2+3)
**Parent feature:** recipe image-carousel strategy for IG / FB / Threads / TikTok. This
is **sub-project 4 of 5** — the orchestration that ties together the renderer (1), slide
hosting (2), and carousel publishers (3). TikTok (5) is built last.

## Goal

A new content strategy `recipe-carousel` that, for a Meta destination (IG / FB / Threads),
takes one already-Telegram-published recipe, renders 3 slides, hosts them at public URLs,
publishes them as a carousel/album, then deletes the hosted slides — with per-destination
dedup. The existing Telegram recipes strategy is untouched.

## Non-goals

TikTok (sub-project 5). Any change to the renderer, hosting service, or publishers.
Translating recipes (the carousel only consumes already-translated rows — see Source).
Telegram publishing (this strategy is Meta-only). WebP transcoding (a non-PNG/JPEG dish
photo falls back to the renderer's solid background — acceptable for v1).

## Why a separate strategy (not extending recipes)

The carousel is "a different strategy per service" (user requirement) and must not change
the Telegram recipe flow. A new `RecipeCarouselStrategy` (`type = 'recipe-carousel'`)
reuses the recipe pool and the three finished sub-projects through their existing
interfaces. The strategy/binding model already routes by `type` with no DB constraint on
the value (scheduler does `registry.get(binding.type)`), so this needs **no migration** —
just registering the strategy and creating a binding (`type='recipe-carousel'` + platform
+ meta_account_id).

## Source of recipes

The carousel consumes **only recipes already published to Telegram** (`posted ?
'TELEGRAM'`), which are therefore guaranteed translated. The carousel never calls Claude
and never races ahead of the Telegram strategy. New repository method (additive — the
existing `getNext` is untouched, so Telegram behavior is unchanged):

```ts
// RecipesRepository
async getNextForCarousel(postedKey: string): Promise<RecipeRow | null>
```
```sql
SELECT <same columns as getNext>
FROM recipes
WHERE (posted ? 'TELEGRAM')          -- already on Telegram ⇒ translated
  AND NOT (posted ? $1)              -- not yet on THIS destination (IG:/FB:/TH:<uuid>)
  AND title_uk IS DISTINCT FROM ''   -- not the skip sentinel (defensive)
  AND kcal IS NOT NULL               -- carries the БЖВ block, matches getNext's pool
ORDER BY created_at
LIMIT 1
```

## Components

### `RecipeCarouselStrategy` — `src/strategies/recipe-carousel/recipe-carousel.strategy.ts`

`@Injectable()`, `implements ContentStrategy, OnModuleInit`, `readonly type =
'recipe-carousel'`. `onModuleInit()` registers itself. `getSkills()` returns `[]`;
`fetch`/`generate` return null (this strategy drives itself via `execute`).

Constructor injects: `RecipesRepository` (from `RecipesStrategyModule`),
`RecipeCarouselRendererService` (CommonModule @Global), `SlideHostingService`
(PublishersModule @Global), `PublisherDispatcher` (PublishersModule @Global),
`ImageResolverService` (CommonModule @Global), `ContentStrategyRegistry` (@Global).

`execute(channelId, params, dest?)` — Meta-only:
1. `if (!dest || dest.platform === 'telegram')` → `logger.warn` + return (carousel isn't a Telegram format).
2. `if (!dest.token)` → `logger.error` + return (DestinationResolver guarantees a token; guard anyway).
3. `row = await repo.getNextForCarousel(dest.postedKey)`; if `!row` → `logger.debug('No carousel-eligible recipes')` + return.
4. `recipe = toCarouselRecipe(row)`; `caption = buildCarouselCaption(row)`.
5. `imageBuffer = await images.download(row.image_url)`; if `null` → `throw new Error('Carousel image download failed')` (transient; row stays unposted, retried next tick).
6. `slides = await renderer.render(recipe, imageBuffer)` → 3 PNG buffers (default 1080×1350).
7. `keyPrefix = `carousel/${dest.platform}/${dest.metaAccountId}/${row.id}``; `hosted = await hosting.upload(slides, keyPrefix)` → `HostedSlide[]`. (`upload` throws if hosting is unconfigured — surfaces as a visible error.)
8. Publish with cleanup:
```ts
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
  if (isPermanentMetaMediaError(msg)) {
    try { await this.repo.markPosted(row.id, dest.postedKey); } catch { /* best-effort */ }
  }
  throw new Error(`Carousel publish (${dest.platform}): ${msg}`);
} finally {
  await this.hosting.delete(hosted.map(h => h.path)); // best-effort; never throws
}
```

Rationale: IG/Threads fetch each slide URL during container creation (inside
`publishCarousel`), and FB during the unpublished-photo upload — so by the time
`publishCarousel` returns (success or failure) the bytes have been ingested or won't be
used. Deleting in `finally` cleans up in every case. `markPosted` writes the
per-destination dedup key; permanent media errors advance the queue; transient errors
leave the row for the next tick. The throw surfaces failures so the scheduler records the
run as an error (the runner re-throws for Meta destinations).

### Pure helper — `src/strategies/recipe-carousel/recipe-carousel.map.ts`

Dependency-free, unit-tested:

```ts
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

/** Short post caption (slides carry the detail): title + cuisine + macros + CTA. */
export function buildCarouselCaption(row: RecipeRow): string {
  const lines: string[] = [row.title_uk ?? ''];
  if (row.category) lines.push(`🍽️ ${row.category}`);
  const macros = macrosLine(row);
  if (macros) lines.push(macros);
  lines.push('Повний рецепт — гортай 👉');
  return lines.filter(Boolean).join('\n\n');
}

/** Compact per-serving macros line, '' when no data. */
export function macrosLine(row: RecipeRow): string { /* 🔥 kcal · Б p · Ж f · В c */ }
```

`buildCarouselCaption` returns plain text; the publishers run it through `buildCaption`
(IG appends `#<category>` from `tags`; Threads/FB append no hashtags).

### Wiring — `src/strategies/recipe-carousel/recipe-carousel-strategy.module.ts`

```ts
@Module({
  imports:   [RecipesStrategyModule],          // for RecipesRepository
  providers: [RecipeCarouselStrategy],
})
export class RecipeCarouselStrategyModule {}
```

`RecipesStrategyModule` adds `RecipesRepository` to its `exports` (additive — does not
change the Telegram strategy). `RecipeCarouselStrategyModule` is registered in
`AppModule` alongside the other strategy modules.

## Data flow

```
scheduler → resolve binding (type=recipe-carousel, platform, meta_account)
          → DestinationResolver → PublishDestination (postedKey IG:/FB:/TH:<uuid>, token)
          → runner.run → RecipeCarouselStrategy.execute(dest)
            → repo.getNextForCarousel(postedKey)
            → toCarouselRecipe + buildCarouselCaption
            → images.download(image_url)
            → renderer.render → 3 PNG
            → hosting.upload → public URLs
            → dispatcher.publishCarousel → post id
            → repo.markPosted(postedKey)   (finally: hosting.delete)
```

## Error handling (summary)

| Situation | Behavior |
| --- | --- |
| No dest / Telegram dest | warn + return (Meta-only strategy) |
| Missing token | error + return |
| No eligible recipe | debug + return |
| Image download fails (`null`) | throw → retry next tick, row unposted |
| Hosting unconfigured | `upload` throws → surfaced as run error |
| Permanent Meta media error | markPosted (advance) + delete + throw |
| Transient publish error | no markPosted + delete + throw (retry next tick) |
| Cleanup (`delete`) fails | swallowed inside `delete` (best-effort, never throws) |

## Testing

`node:test` via `npm test` (run from `apps/automation`, so `experimentalDecorators` is
honored). **No live network / Claude / publishing** (cost guard). All collaborators mocked.

Pure helper — `recipe-carousel.map.test.ts`:
- `toCarouselRecipe` maps fields and parses pg-NUMERIC strings (`'85'`→85, `''`/`null`→null).
- `buildCarouselCaption` includes title + cuisine + macros + CTA; omits cuisine/macros when absent.

Strategy — `recipe-carousel.strategy.test.ts`, with fake repo/renderer/hosting/dispatcher/images:
- Happy path: `execute` with an IG dest → calls `getNextForCarousel(postedKey)`, `render`, `upload(slides, prefix)`, `publishCarousel(platform, payloadWithCaption, urls, target)`, `markPosted(id, postedKey)`, and `delete(paths)`; returns normally.
- No eligible recipe → returns without rendering/publishing.
- Telegram dest (or no dest) → returns without touching the repo.
- Image download returns null → throws; no upload/publish/markPosted; (no slides to delete).
- Transient publish error → no `markPosted`, `delete` still called, throws.
- Permanent media error (`isPermanentMetaMediaError` matches, e.g. 'aspect ratio') → `markPosted` called, `delete` called, throws.

## Cost / safety guard (standing)

Build + `tsc` + unit tests only (`cd apps/automation && npm test`). No service restart, no
live Graph/Supabase/Claude calls, no publishing. No new dependency. No migration. The
Telegram recipes strategy and all single-image publishing are untouched.

## Deferred

- **TikTok** (sub-project 5): separate integration; the renderer's 9:16 `opts` and a
  TikTok publisher come later.
- **WebP transcode**: if recipe photos are WebP, the renderer falls back to a solid
  background; a transcode step can be added later if needed.
