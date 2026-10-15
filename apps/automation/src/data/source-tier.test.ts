/** Spec 037 T4: source URLs — site roots / section indexes and source tiers, in data. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSiteIndexUrl, primaryLinksOf, sourceTier, tierShare } from './source-tier';

test('isSiteIndexUrl: the 7 homepages of the DEV channels and the section indexes; articles, game pages and repos are not', () => {
  for (const u of [
    'https://www.marktechpost.com/', 'https://www.ynab.com/', 'https://elementsofai.com/', 'https://store.steampowered.com/', 'https://itch.io',
    'https://itch.io/new-and-popular', 'https://store.steampowered.com/search/?specials=1', 'https://store.epicgames.com/en-US/free-games',
    'https://example.com/en/', 'https://example.com/?ref=tg', 'https://example.com/category/ai', 'https://example.com/tag/llm/', 'https://example.com/blog',
  ]) assert.equal(isSiteIndexUrl(u), true, u);
  for (const u of [
    'https://www.marktechpost.com/2026/10/13/google-gemini-4-argon-api-release/', 'https://store.epicgames.com/en-US/p/buried-stars',
    'https://store.steampowered.com/app/1174180/Red_Dead_Redemption_2/', 'https://github.com/modelcontextprotocol/servers',
    'https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo', 'https://www.liquid.ai/blog/d1-open', 'https://developers.googleblog.com/en/embeddinggemma-2-the-developer-guide/',
    'https://faktypro.com.ua/page/20-cikavih-faktiv-pro-shtuchnij-intelekt', 'https://www.gamerpower.com/out-of-sight-epic-games-giveaway',
    'library://recipes/1', 'data://facts/2', '', null,
  ]) assert.equal(isSiteIndexUrl(u), false, String(u));
});

test('sourceTier: primary / media / aggregator / low in data; an unknown domain is null, never guessed', () => {
  assert.equal(sourceTier('https://store.steampowered.com/app/1'), 'primary');
  assert.equal(sourceTier('https://blog.playstation.com/2026/10/05/x/'), 'primary');
  assert.equal(sourceTier('https://arxiv.org/abs/2510.01234'), 'primary');
  assert.equal(sourceTier('https://github.com/org/repo'), 'primary');
  assert.equal(sourceTier('https://docs.somevendor.io/guide'), 'primary', 'a docs host');
  assert.equal(sourceTier('https://techcrunch.com/2026/10/06/a/'), 'media');
  assert.equal(sourceTier('https://dev.ua/news/x'), 'media');
  assert.equal(sourceTier('https://www.marktechpost.com/2026/10/13/x/'), 'aggregator');
  assert.equal(sourceTier('https://www.gamerpower.com/out-of-sight-epic-games-giveaway'), 'aggregator');
  assert.equal(sourceTier('https://faktypro.com.ua/page/20-cikavih-faktiv-pro-shtuchnij-intelekt'), 'low');
  assert.equal(sourceTier('https://someblog.example/fun-facts-about-ai'), 'low', 'a "fun facts" path anywhere');
  assert.equal(sourceTier('https://someblog.example/post', '20 цікавих фактів про ШІ'), 'low', 'a "N interesting facts" title');
  assert.equal(sourceTier('https://someblog.example/post'), null);
  assert.equal(sourceTier('library://recipes/1'), null);
});

test('primaryLinksOf: an aggregator page links the primary source on another site (no self links, no homepages, no media)', () => {
  const links = [
    'https://www.marktechpost.com/2026/10/12/other/', 'https://blog.google/technology/ai/gemini-4-argon/', 'https://techcrunch.com/2026/10/13/x/',
    'https://ai.google.dev/', 'https://arxiv.org/abs/2510.01234', 'https://blog.google/technology/ai/gemini-4-argon/',
  ];
  assert.deepEqual(primaryLinksOf('https://www.marktechpost.com/2026/10/13/google-gemini-4-argon-api-release/', links),
    ['https://blog.google/technology/ai/gemini-4-argon/', 'https://arxiv.org/abs/2510.01234']);
});

test('tierShare: the share of each tier and the top domains (AI Технології lived on MarkTechPost)', () => {
  const s = tierShare([
    ...Array(7).fill('https://www.marktechpost.com/2026/10/0x/a/'), 'https://developers.googleblog.com/en/a/', 'https://github.com/a/b',
    'https://faktypro.com.ua/page/20-cikavih-faktiv', 'https://www.ynab.com/', null, 'library://facts/1',
  ]);
  assert.equal(s.total, 11);
  assert.deepEqual(s.counts, { primary: 2, media: 0, aggregator: 7, low: 1, unknown: 1 });
  assert.equal(s.share!.aggregator, 0.636);
  assert.deepEqual(s.top[0], { host: 'marktechpost.com', n: 7, tier: 'aggregator' });
  assert.deepEqual(tierShare([]), { total: 0, counts: { primary: 0, media: 0, aggregator: 0, low: 0, unknown: 0 }, share: null, top: [] });
});
