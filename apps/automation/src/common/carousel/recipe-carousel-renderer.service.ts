// recipe-carousel-renderer.service.ts — render a recipe into 3 carousel PNG slides.
// Satori (dynamic-imported) builds SVG; resvg rasterizes to PNG. Fonts come from
// @expo-google-fonts/roboto (full static TTFs with Latin + Cyrillic in one file).
// Pure: data + image bytes in, PNGs out.
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

// Full static TTFs (Latin + Cyrillic in one file) — satori does not merge split
// subset files, so a single full-coverage file per weight is required for Ukrainian.
const FONT_FILES: Array<{ file: string; weight: number }> = [
  { file: '400Regular/Roboto_400Regular.ttf', weight: 400 },
  { file: '700Bold/Roboto_700Bold.ttf',        weight: 700 },
];

const ACCENT = '#3ECF8E';
const INK = '#FFFFFF';
const SUB = 'rgba(255,255,255,0.82)';

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
    data: readFileSync(require.resolve(`@expo-google-fonts/roboto/${f.file}`)),
  }));

  private async getSatori(): Promise<SatoriFn> {
    if (!this.satori) {
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
