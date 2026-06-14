import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RecipeCarouselRendererService, type CarouselRecipe } from './recipe-carousel-renderer.service';

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
  assert.equal(slides[0].readUInt32BE(16), 1080);
  assert.equal(slides[0].readUInt32BE(20), 1920);
});

test('bad image buffer falls back to solid background (no throw)', async () => {
  const svc = new RecipeCarouselRendererService();
  const slides = await svc.render(recipe(), Buffer.from([0, 1, 2, 3]));
  assert.equal(slides.length, 3);
  for (const s of slides) assert.ok(isPng(s));
});
