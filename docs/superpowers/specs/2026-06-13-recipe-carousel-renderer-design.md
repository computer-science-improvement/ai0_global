# Recipe Carousel Renderer (sub-project 1/5) — Design

**Status:** approved (brainstorming) — 2026-06-13
**Branch:** `feat/carousel-renderer` (off `develop`)
**Parent feature:** recipe image-carousel strategy for IG / FB / Threads / TikTok. This
is **sub-project 1 of 5** (the foundation). The others get their own spec→plan→build:
2) public slide hosting, 3) carousel publishers (IG/FB/Threads), 4) the
`recipe-carousel` strategy wired into the binding model, 5) TikTok (separate
integration, gated by TikTok app review).

## Goal

A pure, self-contained service that turns one recipe's data + dish photo into **three
PNG slides** (a carousel) — dish photo as background with a text overlay on each:
1. dish name + cuisine + БЖВ + calories; 2. ingredients; 3. how to cook. No DB, no
network, no external APIs — it receives data + image bytes and returns PNG buffers.

## Non-goals (explicitly later sub-projects)

Hosting the PNGs at public URLs, publishing carousels to any platform, the strategy
that selects recipes and dedups, per-platform APIs, TikTok. The **existing Telegram
recipes strategy is untouched.**

## Stack

- **satori** — JSX/element-tree → SVG. Built as plain element objects (`{ type, props }`)
  so no React runtime is added to the backend.
- **@resvg/resvg-js** — SVG → PNG (native Rust module).
- **A bundled Cyrillic-capable font** committed to the repo (e.g. Inter, regular +
  semibold/bold weights, with Cyrillic glyphs). Without an embedded font Satori
  renders Ukrainian text as blank boxes. Fonts live at
  `apps/automation/assets/fonts/` and are loaded from disk at service init.

## Component

`src/common/carousel/recipe-carousel-renderer.service.ts` — `RecipeCarouselRendererService`.

```ts
export interface CarouselRecipe {
  titleUk:        string;
  category:       string | null;   // cuisine
  kcal:           number | null;
  proteinG:       number | null;
  fatG:           number | null;
  carbsG:         number | null;
  ingredientsUk:  string;          // newline / "•" separated
  instructionsUk: string;          // newline / numbered steps
}

export interface CarouselRenderOpts {
  width?:  number;   // default 1080
  height?: number;   // default 1350 (4:5)
}

// returns exactly 3 PNG buffers: [coverSlide, ingredientsSlide, stepsSlide]
render(recipe: CarouselRecipe, imageBuffer: Buffer, opts?: CarouselRenderOpts): Promise<Buffer[]>
```

The caller (a later sub-project's strategy) maps `recipes` rows (`title_uk`, `category`,
`kcal`/`protein_g`/`fat_g`/`carbs_g` which are pg-NUMERIC **strings** → parse to number,
`ingredients_uk`, `instructions_uk`) into `CarouselRecipe`, and downloads `image_url`
into `imageBuffer`.

## Slide designs (all 3 share width×height + the dish photo background)

Background: the dish photo, cover-fit (centered, cropped to fill). A dark vertical
gradient overlay (transparent → ~0.85 black at the bottom, plus a lighter top scrim)
guarantees text contrast over any photo. Brand accent color used for chips/numbers.
Clean dark "food editorial" style; exact palette/spacing iterated on real sample
renders during implementation.

1. **Cover** — bottom-anchored: large bold **dish name** (auto-shrink font to fit ≤3
   lines), a small **cuisine chip** (category) above it, and a row of stat **pills**
   below: `🔥 {kcal} ккал · Б {protein} · Ж {fat} · В {carbs}` (omit any null metric).
2. **Ingredients** — top label «Інгредієнти»; a readable list built from
   `ingredientsUk` (split on newlines/`•`/`;`), each line a bulleted row on a
   semi-transparent panel. Overflow: cap the visible lines and append «…» / shrink.
3. **Steps** — top label «Покроково»; numbered steps from `instructionsUk` (split on
   newlines or `\d.` markers). Overflow: cap steps / shrink font to fit the height.

A shared internal helper builds the common frame (background + gradient + safe-area
padding); each slide supplies its overlay content. Text helpers: number formatting,
list splitting, and a fit-to-height shrink/truncate.

## Data flow

`CarouselRecipe + imageBuffer` → for each of 3 slides: build Satori element tree →
`satori(tree, { width, height, fonts })` → SVG string → `new Resvg(svg).render().asPng()`
→ Buffer. Return `[png1, png2, png3]`.

## Error handling

- Missing/empty `ingredientsUk` or `instructionsUk` → that slide shows a graceful
  «—»/placeholder rather than throwing (the renderer never throws on content shape).
- A corrupt/undecodable `imageBuffer` → fall back to a solid brand-color background
  (so a bad photo doesn't break rendering); log nothing here (pure service — the
  caller logs).
- Font load failure at init throws (fail fast — misconfiguration).

## Testing

`node:test` via `npx tsx --test`:
- Renders all 3 slides for a Ukrainian-text recipe → returns exactly 3 buffers, each a
  valid PNG (magic bytes `89 50 4E 47`).
- Long `ingredientsUk` / `instructionsUk` (many lines) → still 3 valid PNGs (no throw).
- Null metrics (kcal/protein null) → cover renders without the missing pills, no throw.
- Empty ingredients/instructions → no throw, placeholder slide.
- Custom dimensions (e.g. 1080×1920) honored (output PNG has those pixel dims).
- A test helper writes the sample PNGs to a gitignored `tmp/carousel-samples/` dir for
  manual visual review (not asserted, just for eyeballing during implementation).

## Cost / safety guard (standing)

Build + `tsc` + unit tests only. No service restart, no network, no publishing. Adding
`satori` + `@resvg/resvg-js` + font files is the only dependency change. The dish photo
in tests is a small fixture buffer (no live download).

## Open decisions deferred to later sub-projects

- **Hosting** (sub-project 2): IG/Threads carousels need public HTTPS URLs per slide;
  the choice (S3/R2 vs self-served static) is made there, not here. The renderer just
  returns buffers.
- **Per-platform dimensions**: default 4:5 for IG/FB/Threads; TikTok 9:16 passed via
  `opts` when sub-project 5 lands. The renderer is already parametric.
