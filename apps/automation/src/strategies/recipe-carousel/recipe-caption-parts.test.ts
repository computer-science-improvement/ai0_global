import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecipeCaptionParts, renderParts } from './recipe-caption-parts';
import { buildCarouselCaption } from './recipe-carousel.map';
import { composeMetaCaption, recipeHashtags } from '../../common/content-strategy/meta-caption.util';
import type { RecipeRow } from '../recipes/recipes.repository';

const ROW = {
  title_uk: 'Омлет з томатами', category: 'Сніданки',
  kcal: '320', protein_g: '18', fat_g: '22', carbs_g: '6',
} as unknown as RecipeRow;

const TG_LINK = 'https://t.me/ai0recipes';
const LABEL = '📲 Більше рецептів у Telegram:';

test('regression: empty overrides reproduce the previous Telegram + Meta captions exactly', () => {
  const parts = buildRecipeCaptionParts(ROW, { telegramLink: TG_LINK });

  // Telegram == the old buildCarouselCaption (title/category/macros/cta).
  assert.equal(renderParts(parts, 'telegram'), buildCarouselCaption(ROW));

  // Facebook == old composeMetaCaption(base, hashtags, link).
  const expectedFb = composeMetaCaption('facebook', {
    base: buildCarouselCaption(ROW), hashtags: recipeHashtags('Сніданки'),
    telegramLink: TG_LINK, linkLabel: LABEL,
  });
  assert.equal(renderParts(parts, 'facebook'), expectedFb);

  // Instagram == same minus the link.
  const expectedIg = composeMetaCaption('instagram', {
    base: buildCarouselCaption(ROW), hashtags: recipeHashtags('Сніданки'),
    telegramLink: TG_LINK, linkLabel: LABEL,
  });
  assert.equal(renderParts(parts, 'instagram'), expectedIg);
});

test('platform rules: hashtags on all Meta, link only on FB/Threads, neither on Telegram', () => {
  const parts = buildRecipeCaptionParts(ROW, { telegramLink: TG_LINK });
  const ig = renderParts(parts, 'instagram');
  const fb = renderParts(parts, 'facebook');
  const th = renderParts(parts, 'threads');
  const tg = renderParts(parts, 'telegram');

  for (const cap of [ig, fb, th]) assert.match(cap, /#recipe/);
  assert.ok(!ig.includes('t.me'), 'IG has no link');
  assert.match(fb, /t\.me\/ai0recipes/);
  assert.match(th, /t\.me\/ai0recipes/);
  assert.ok(!tg.includes('#recipe') && !tg.includes('t.me'), 'Telegram has neither hashtags nor link');
});

test('no telegram link → no link section on FB', () => {
  const parts = buildRecipeCaptionParts(ROW, { telegramLink: null });
  assert.ok(!renderParts(parts, 'facebook').includes('t.me'));
});

test('overrides win and flip the part source to custom', () => {
  const parts = buildRecipeCaptionParts(ROW, {
    telegramLink: TG_LINK,
    overrides: { cta: 'Замовляй зараз!', hashtags: ['foodie', 'yum'], intro: 'Привіт!', outro: 'Смачного 🍽', tgLinkLabel: 'TG:' },
  });
  const fb = renderParts(parts, 'facebook');
  assert.match(fb, /^Привіт!/);                 // intro first
  assert.match(fb, /Замовляй зараз!/);          // cta override
  assert.match(fb, /#foodie #yum/);             // hashtags override
  assert.ok(!fb.includes('#recipe'));           // default hashtags gone
  assert.match(fb, /Смачного/);                 // outro
  assert.match(fb, /TG: https:\/\/t\.me/);      // custom link label

  const byKey = Object.fromEntries(parts.map(p => [p.key, p.source]));
  assert.equal(byKey.cta, 'custom');
  assert.equal(byKey.hashtags, 'custom');
  assert.equal(byKey.title, 'recipe');
  assert.equal(byKey.macros, 'computed');
});
