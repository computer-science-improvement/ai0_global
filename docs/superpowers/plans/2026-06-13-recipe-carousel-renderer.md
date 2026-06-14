# Recipe Carousel Renderer (sub-project 1/5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure NestJS service that renders one recipe into three carousel PNG slides (cover / ingredients / steps) via Satori + resvg, with Cyrillic font support.

**Architecture:** Pure text/data helpers (tested in isolation) feed a renderer that builds Satori element trees, rasterizes each to PNG with resvg, and returns `Buffer[3]`. No DB, no network, no platform APIs. Satori is ESM-only so it's loaded via dynamic `import()` from our CommonJS runtime; fonts ship via `@fontsource/roboto` (Latin + Cyrillic woff subsets).

**Tech Stack:** NestJS (CommonJS, Node 22), `satori`, `@resvg/resvg-js`, `@fontsource/roboto`, node:test via `npx tsx --test`.

**Spec:** `docs/superpowers/specs/2026-06-13-recipe-carousel-renderer-design.md`
**Branch:** `feat/carousel-renderer` (already created off `develop`). Work from `apps/automation`.

**Cost/safety guard (STANDING):** Build + `tsc` + unit tests only. No service restart, no network at runtime, no publishing. The only dependency change is the three npm packages below.

---

## File Structure
- Create: `apps/automation/src/common/carousel/carousel-text.ts` — pure helpers (parse/split/dataUrl).
- Create: `apps/automation/src/common/carousel/carousel-text.test.ts`
- Create: `apps/automation/src/common/carousel/recipe-carousel-renderer.service.ts` — the renderer.
- Create: `apps/automation/src/common/carousel/recipe-carousel-renderer.service.test.ts`
- Modify: `apps/automation/package.json` (deps).
- Modify: `apps/automation/src/common/common.module.ts` (provide+export the service).
- Modify: `apps/automation/.gitignore` or root `.gitignore` if needed for `tmp/` sample output (only if not already ignored).

---

### Task 1: Dependencies

**Files:** Modify `apps/automation/package.json` (+ lockfile).

- [ ] **Step 1: Install**

Run (from `apps/automation`):
```bash
npm install satori @resvg/resvg-js @fontsource/roboto
```

- [ ] **Step 2: Verify the font subset files resolve**

Run:
```bash
node -e "console.log(require.resolve('@fontsource/roboto/files/roboto-latin-400-normal.woff')); console.log(require.resolve('@fontsource/roboto/files/roboto-cyrillic-400-normal.woff')); console.log(require.resolve('@fontsource/roboto/files/roboto-latin-700-normal.woff')); console.log(require.resolve('@fontsource/roboto/files/roboto-cyrillic-700-normal.woff'))"
```
Expected: four absolute paths printed (no MODULE_NOT_FOUND). If any subset name differs, `ls node_modules/@fontsource/roboto/files | grep -E 'latin-(400|700)-normal\.woff$|cyrillic-(400|700)-normal\.woff$'` to find the exact names and use those in Task 3.

- [ ] **Step 3: Verify resvg loads (native module)**

Run: `node -e "const {Resvg}=require('@resvg/resvg-js'); console.log(typeof Resvg)"` → expect `function`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(carousel): add satori + @resvg/resvg-js + @fontsource/roboto"
```

---

### Task 2: Pure text/data helpers

**Files:**
- Create: `apps/automation/src/common/carousel/carousel-text.ts`
- Create: `apps/automation/src/common/carousel/carousel-text.test.ts`

- [ ] **Step 1: Write the failing test**

Create `carousel-text.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNum, splitIngredients, splitSteps, imageDataUrl } from './carousel-text';

test('parseNum: numeric strings → number, junk/null → null', () => {
  assert.equal(parseNum('84.55'), 84.55);
  assert.equal(parseNum('120'), 120);
  assert.equal(parseNum(null), null);
  assert.equal(parseNum(''), null);
  assert.equal(parseNum('abc'), null);
});

test('splitIngredients: splits on newlines / bullets / semicolons, trims, drops empties', () => {
  assert.deepEqual(splitIngredients('Картопля — 1 кг\n• Масло — 100 г\n\nСіль'),
    ['Картопля — 1 кг', 'Масло — 100 г', 'Сіль']);
  assert.deepEqual(splitIngredients('Цукор; Борошно;'), ['Цукор', 'Борошно']);
  assert.deepEqual(splitIngredients(''), []);
});

test('splitSteps: splits numbered or newline steps, strips leading numbering', () => {
  assert.deepEqual(splitSteps('1. Розтопіть масло.\n2. Додайте картоплю.'),
    ['Розтопіть масло.', 'Додайте картоплю.']);
  assert.deepEqual(splitSteps('Помити.\nПорізати.'), ['Помити.', 'Порізати.']);
  assert.deepEqual(splitSteps(''), []);
});

test('imageDataUrl: sniffs PNG vs JPEG magic bytes', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  assert.match(imageDataUrl(png), /^data:image\/png;base64,/);
  assert.match(imageDataUrl(jpg), /^data:image\/jpeg;base64,/);
});
```

Run: `npx tsx --test src/common/carousel/carousel-text.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement**

Create `carousel-text.ts`:

```ts
// carousel-text.ts — pure helpers for the recipe carousel renderer (no I/O).

/** pg NUMERIC arrives as a string; parse to a finite number or null. */
export function parseNum(s: string | null): number | null {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Split an ingredients blob into clean lines (newlines, bullets, semicolons). */
export function splitIngredients(s: string): string[] {
  return (s ?? '')
    .split(/[\n;•]+/)
    .map(x => x.replace(/^[\s\-–—*]+/, '').trim())
    .filter(Boolean);
}

/** Split an instructions blob into steps, stripping any leading "1." numbering. */
export function splitSteps(s: string): string[] {
  return (s ?? '')
    .split(/\n+|(?=\b\d{1,2}[.)]\s)/)
    .map(x => x.replace(/^\s*\d{1,2}[.)]\s*/, '').trim())
    .filter(Boolean);
}

/** Build a data URL from image bytes, sniffing PNG vs JPEG (default JPEG). */
export function imageDataUrl(buf: Buffer): string {
  const isPng = buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const mime = isPng ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}
```

- [ ] **Step 3: Run → PASS**

Run: `npx tsx --test src/common/carousel/carousel-text.test.ts` → expect `# pass 4`.

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit -p tsconfig.json` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/common/carousel/carousel-text.ts src/common/carousel/carousel-text.test.ts
git commit -m "feat(carousel): pure text/data helpers (parse/split/dataUrl)"
```

---

### Task 3: Renderer service

**Files:**
- Create: `apps/automation/src/common/carousel/recipe-carousel-renderer.service.ts`
- Create: `apps/automation/src/common/carousel/recipe-carousel-renderer.service.test.ts`

KEY INTEGRATION NOTES:
- **Satori is ESM-only** — load it with `await import('satori')` (a cached dynamic import), NOT `require`/static import, because the runtime is CommonJS.
- **resvg** is a native CJS module: `const { Resvg } = require('@resvg/resvg-js')` (or `import`).
- **Fonts**: load the four `@fontsource/roboto` woff subset files via `require.resolve(...)` + `readFileSync`, registered as family `'Roboto'` (weights 400 + 700, Latin + Cyrillic). Satori falls back across same-family entries for glyph coverage, so Ukrainian text resolves.
- Satori element trees are built as plain objects `{ type, props: { style, children } }` (no React). Use a tiny `h` helper, cast to `any` for satori's React-typed signature.

- [ ] **Step 1: Write the failing test**

Create `recipe-carousel-renderer.service.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RecipeCarouselRendererService, type CarouselRecipe } from './recipe-carousel-renderer.service';

// 1×1 white PNG as the dish photo fixture.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function recipe(over: Partial<CarouselRecipe> = {}): CarouselRecipe {
  return {
    titleUk: 'Пом Анна', category: 'Французька',
    kcal: 84.55, proteinG: 4.43, fatG: 0.35, carbsG: 15.93,
    ingredientsUk: 'Картопля — 1 кг\nМасло — 100 г\nСіль',
    instructionsUk: '1. Розтопіть масло.\n2. Додайте картоплю.\n3. Запікайте 40 хв.',
    ...over,
  };
}

function isPng(b: Buffer): boolean {
  return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

test('renders 3 valid PNG slides for a Ukrainian recipe + writes samples', async () => {
  const svc = new RecipeCarouselRendererService();
  const slides = await svc.render(recipe(), PNG_1x1);
  assert.equal(slides.length, 3);
  for (const s of slides) assert.ok(isPng(s), 'each slide is a PNG');
  // Eyeball samples (not asserted):
  const dir = join(process.cwd(), 'tmp', 'carousel-samples');
  mkdirSync(dir, { recursive: true });
  slides.forEach((b, i) => writeFileSync(join(dir, `slide-${i + 1}.png`), b));
});

test('handles null metrics + empty content without throwing', async () => {
  const svc = new RecipeCarouselRendererService();
  const slides = await svc.render(
    recipe({ kcal: null, proteinG: null, fatG: null, carbsG: null, ingredientsUk: '', instructionsUk: '' }),
    PNG_1x1,
  );
  assert.equal(slides.length, 3);
  for (const s of slides) assert.ok(isPng(s));
});

test('handles very long ingredients/steps without throwing', async () => {
  const svc = new RecipeCarouselRendererService();
  const long = Array.from({ length: 40 }, (_, i) => `Інгредієнт номер ${i + 1} — багато тексту тут`).join('\n');
  const slides = await svc.render(recipe({ ingredientsUk: long, instructionsUk: long }), PNG_1x1);
  assert.equal(slides.length, 3);
  for (const s of slides) assert.ok(isPng(s));
});

test('honors custom dimensions (9:16)', async () => {
  const svc = new RecipeCarouselRendererService();
  const slides = await svc.render(recipe(), PNG_1x1, { width: 1080, height: 1920 });
  assert.equal(slides.length, 3);
  // PNG width is bytes 16-19 (big-endian) of the IHDR chunk.
  const w = slides[0].readUInt32BE(16);
  const h = slides[0].readUInt32BE(20);
  assert.equal(w, 1080);
  assert.equal(h, 1920);
});

test('bad image buffer falls back to solid background (no throw)', async () => {
  const svc = new RecipeCarouselRendererService();
  const slides = await svc.render(recipe(), Buffer.from([0, 1, 2, 3]));
  assert.equal(slides.length, 3);
  for (const s of slides) assert.ok(isPng(s));
});
```

Run: `npx tsx --test src/common/carousel/recipe-carousel-renderer.service.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement the renderer**

Create `recipe-carousel-renderer.service.ts`:

```ts
// recipe-carousel-renderer.service.ts — render a recipe into 3 carousel PNG slides.
// Satori (ESM, dynamic-imported) builds SVG; resvg rasterizes to PNG. Fonts come
// from @fontsource/roboto (Latin + Cyrillic). Pure: data + image bytes in, PNGs out.
import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { splitIngredients, splitSteps, imageDataUrl } from './carousel-text';

export interface CarouselRecipe {
  titleUk:        string;
  category:       string | null;
  kcal:           number | null;
  proteinG:       number | null;
  fatG:           number | null;
  carbsG:         number | null;
  ingredientsUk:  string;
  instructionsUk: string;
}

export interface CarouselRenderOpts { width?: number; height?: number; }

type SatoriFn = (element: any, options: any) => Promise<string>;

const FONT_FILES: Array<{ subset: string; weight: number }> = [
  { subset: 'latin',    weight: 400 },
  { subset: 'cyrillic', weight: 400 },
  { subset: 'latin',    weight: 700 },
  { subset: 'cyrillic', weight: 700 },
];

const ACCENT = '#3ECF8E';
const INK = '#FFFFFF';
const SUB = 'rgba(255,255,255,0.82)';

/** Plain-object Satori element (no React). */
function h(type: string, style: Record<string, unknown>, children?: any): any {
  return { type, props: { style, ...(children !== undefined ? { children } : {}) } };
}

@Injectable()
export class RecipeCarouselRendererService {
  private satori?: SatoriFn;
  private readonly fonts = FONT_FILES.map(f => ({
    name: 'Roboto',
    weight: f.weight as 400 | 700,
    style: 'normal' as const,
    data: readFileSync(require.resolve(`@fontsource/roboto/files/roboto-${f.subset}-${f.weight}-normal.woff`)),
  }));

  private async getSatori(): Promise<SatoriFn> {
    if (!this.satori) {
      // satori is ESM-only. Under `module: commonjs`, tsc would rewrite a plain
      // `import('satori')` into `require()` (which throws on an ESM-only package),
      // so go through the Function constructor to keep a REAL dynamic import that
      // tsc won't transform. Works in both tsx (tests) and the CJS runtime.
      const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
      this.satori = (await esmImport('satori')).default as SatoriFn;
    }
    return this.satori;
  }

  async render(recipe: CarouselRecipe, imageBuffer: Buffer, opts: CarouselRenderOpts = {}): Promise<Buffer[]> {
    const width = opts.width ?? 1080;
    const height = opts.height ?? 1350;
    const bg = this.backgroundStyle(imageBuffer);
    const slides = [
      this.cover(recipe, bg, width, height),
      this.panelSlide('Інгредієнти', splitIngredients(recipe.ingredientsUk), bg, width, height, false),
      this.panelSlide('Покроково', splitSteps(recipe.instructionsUk), bg, width, height, true),
    ];
    const satori = await this.getSatori();
    const out: Buffer[] = [];
    for (const tree of slides) {
      const svg = await satori(tree, { width, height, fonts: this.fonts });
      out.push(new Resvg(svg).render().asPng());
    }
    return out;
  }

  /** Background: dish photo cover-fit, or solid brand color if the bytes are unusable. */
  private backgroundStyle(buf: Buffer): Record<string, unknown> {
    const base: Record<string, unknown> = {
      position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
      display: 'flex', backgroundColor: '#11140F',
    };
    const looksImage = buf.length > 8 &&
      ((buf[0] === 0x89 && buf[1] === 0x50) || (buf[0] === 0xff && buf[1] === 0xd8));
    if (looksImage) {
      base.backgroundImage = `url(${imageDataUrl(buf)})`;
      base.backgroundSize = 'cover';
      base.backgroundPosition = 'center';
    }
    return base;
  }

  /** Dark gradient overlay for text contrast. */
  private scrim(): any {
    return h('div', {
      position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', display: 'flex',
      backgroundImage: 'linear-gradient(180deg, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.0) 30%, rgba(0,0,0,0.25) 60%, rgba(0,0,0,0.88) 100%)',
    });
  }

  private frame(width: number, height: number, bg: Record<string, unknown>, content: any): any {
    return h('div', {
      width, height, display: 'flex', flexDirection: 'column', position: 'relative',
      fontFamily: 'Roboto', color: INK, padding: 64, justifyContent: 'flex-end',
    }, [ h('div', bg), this.scrim(), content ]);
  }

  private chip(text: string): any {
    return h('div', {
      display: 'flex', alignSelf: 'flex-start', backgroundColor: ACCENT, color: '#0B0E0A',
      fontSize: 30, fontWeight: 700, padding: '8px 18px', borderRadius: 999, marginBottom: 20,
    }, text);
  }

  private cover(r: CarouselRecipe, bg: Record<string, unknown>, w: number, h2: number): any {
    // Auto-shrink the title font for long names.
    const titleLen = r.titleUk.length;
    const titleSize = titleLen > 42 ? 64 : titleLen > 26 ? 80 : 96;
    const pills: string[] = [];
    if (r.kcal != null)    pills.push(`${Math.round(r.kcal)} ккал`);
    if (r.proteinG != null) pills.push(`Б ${r.proteinG}`);
    if (r.fatG != null)     pills.push(`Ж ${r.fatG}`);
    if (r.carbsG != null)   pills.push(`В ${r.carbsG}`);

    const content = h('div', { display: 'flex', flexDirection: 'column' }, [
      ...(r.category ? [this.chip(r.category)] : []),
      h('div', { display: 'flex', fontSize: titleSize, fontWeight: 700, lineHeight: 1.05, letterSpacing: '-0.02em' }, r.titleUk),
      ...(pills.length ? [h('div', { display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 28 },
        pills.map(p => h('div', {
          display: 'flex', backgroundColor: 'rgba(255,255,255,0.14)', color: INK,
          fontSize: 30, fontWeight: 700, padding: '10px 20px', borderRadius: 14,
        }, p)))] : []),
    ]);
    return this.frame(w, h2, bg, content);
  }

  /** Ingredients (bulleted) or steps (numbered) on a readable panel. Fit-to-height. */
  private panelSlide(title: string, items: string[], bg: Record<string, unknown>, w: number, h2: number, numbered: boolean): any {
    const shown = items.slice(0, 12);
    const overflow = items.length - shown.length;
    const rowSize = shown.length > 9 ? 30 : shown.length > 6 ? 36 : 42;

    const rows = shown.length === 0
      ? [h('div', { display: 'flex', fontSize: 38, color: SUB }, '—')]
      : shown.map((it, i) => h('div', { display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 16 }, [
          h('div', {
            display: 'flex', flexShrink: 0, minWidth: numbered ? 46 : 16,
            color: ACCENT, fontSize: rowSize, fontWeight: 700,
          }, numbered ? `${i + 1}.` : '•'),
          h('div', { display: 'flex', fontSize: rowSize, lineHeight: 1.25, color: INK }, it),
        ]));
    if (overflow > 0) rows.push(h('div', { display: 'flex', fontSize: 28, color: SUB, marginTop: 8 }, `+ ще ${overflow}`));

    const panel = h('div', {
      display: 'flex', flexDirection: 'column',
      backgroundColor: 'rgba(10,12,9,0.72)', borderRadius: 28, padding: 48,
    }, [
      h('div', { display: 'flex', fontSize: 30, fontWeight: 700, color: ACCENT, marginBottom: 28, letterSpacing: '0.04em' }, title.toUpperCase()),
      h('div', { display: 'flex', flexDirection: 'column' }, rows),
    ]);
    return this.frame(w, h2, bg, panel);
  }
}
```

NOTE for the implementer: if `npx tsc` flags satori's element typing on `satori(tree, …)`, the `h()` output is already `any`; keep the `SatoriFn` signature as `(element: any, options: any)`. If the `@fontsource` woff subset filenames differ from `roboto-<subset>-<weight>-normal.woff` (per Task 1 Step 2), update the `require.resolve` template literal to the real names. If satori's `fonts[].weight` typing rejects the union, type the array as `any[]`.

- [ ] **Step 3: Run → PASS**

Run: `npx tsx --test src/common/carousel/recipe-carousel-renderer.service.test.ts`
Expected: `# pass 5`, `# fail 0`. Then open `apps/automation/tmp/carousel-samples/slide-{1,2,3}.png` and eyeball: Ukrainian text renders (no blank boxes), dish bg + gradient + readable overlay. If text is blank → the font didn't load (recheck Task 1 Step 2 subset names).

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit -p tsconfig.json` → no errors.

- [ ] **Step 5: Ignore sample output**

Ensure `tmp/` is gitignored. Check: `git check-ignore apps/automation/tmp/carousel-samples/slide-1.png` — if it prints nothing (not ignored), add `tmp/` to `apps/automation/.gitignore` (create the file with a single line `tmp/` if absent).

- [ ] **Step 6: Commit**

```bash
git add src/common/carousel/recipe-carousel-renderer.service.ts src/common/carousel/recipe-carousel-renderer.service.test.ts .gitignore
git commit -m "feat(carousel): RecipeCarouselRendererService — 3-slide PNG render (Satori+resvg)"
```

---

### Task 4: Wire into CommonModule + full verification

**Files:** Modify `apps/automation/src/common/common.module.ts`

- [ ] **Step 1: Provide + export the service**

In `common.module.ts`, add the import and put `RecipeCarouselRendererService` in the `SERVICES` array (the same array that holds the other common services, spread into both `providers` and `exports`):
```ts
import { RecipeCarouselRendererService } from './carousel/recipe-carousel-renderer.service';
```
Add `RecipeCarouselRendererService` to that array. (This makes it injectable by the future `recipe-carousel` strategy; the @Global CommonModule exports it app-wide.)

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit -p tsconfig.json` → no errors.

- [ ] **Step 3: Full automation suite**

Run: `npx tsx --test "src/**/*.test.ts"` → all pass, `# fail 0`. (Confirms the new deps + dynamic import don't break the suite. The renderer tests are the slowest; that's expected.)

- [ ] **Step 4: Commit**

```bash
git add src/common/common.module.ts
git commit -m "feat(carousel): register RecipeCarouselRendererService in CommonModule"
```

---

## Out of scope (next sub-projects)

- 2: public hosting of the slide PNGs (S3/R2 vs static) — needed for IG/Threads carousels.
- 3: carousel publishers (IG carousel, Threads carousel, FB album) in the dispatcher.
- 4: the `recipe-carousel` strategy (select posted recipe → render → host → publish → per-destination dedup), wired into the binding/destination model.
- 5: TikTok (own integration + OAuth + Content Posting API + app review; 9:16 via the renderer's `opts`).

The existing Telegram recipes strategy is not touched by any of this.

## Post-implementation

Use `superpowers:finishing-a-development-branch`. Per the user's standing preference: do NOT push; merge to `develop` only when they ask. Then brainstorm sub-project 2 (hosting).
