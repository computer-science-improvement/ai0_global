/** Spec 037 T11: the critic sees the post's images — network posters by name and use_for — and the source page's main image. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criticMediaLines, criticMediaOf } from './critic-media';
import { criticUserPrompt, type CriticRequest } from './critic.service';
import { CriticGate } from './critic-gate';
import type { EditorTool } from '../harness/tool';
import { STORED_SOURCES_MAX, storedSourcesOf } from './stored-sources';
import { parseSources } from '../audit/post-audit';

const POSTER = 'https://prdruteophdbnypnikij.supabase.co/storage/v1/object/public/common/01-prompt.png';

test('criticMediaOf: posters named with use_for, plain images by URL, video skipped; null without images', () => {
  const m = criticMediaOf({ media: [{ url: POSTER }, { url: 'https://cdn.example/a.jpg' }, { url: 'https://cdn.example/v.mp4', kind: 'video' }] }, null);
  assert.deepEqual(m, {
    images: [{ url: POSTER, poster: { title: 'Prompt', useFor: 'пост про один промпт або техніку промптингу' } }, { url: 'https://cdn.example/a.jpg' }],
    sourceImage: null,
  });
  assert.equal(criticMediaOf({ media: [] }), null);
  assert.equal(criticMediaOf(null), null);
  assert.equal('sourceImage' in criticMediaOf({ media: [{ url: POSTER }] })!, false, 'the page was not read: unknown');
});

test('criticMediaLines → the critic prompt shows the poster name and use_for and the source image', () => {
  const lines = criticMediaLines(criticMediaOf({ media: [{ url: POSTER }] }, 'https://news.example/og.jpg')).join('\n');
  assert.match(lines, /постер мережі «Prompt», use_for: пост про один промпт/);
  assert.match(lines, /Головне зображення сторінки-джерела: https:\/\/news\.example\/og\.jpg/);
  assert.match(criticMediaLines(criticMediaOf({ media: [{ url: 'https://x.example/a.jpg' }] }, null)).join('\n'), /без зображення: новина має йти без media/);
  assert.deepEqual(criticMediaLines(null), []);

  const req: CriticRequest = {
    channelKey: 'c', slotId: 's', mode: 'live', resourceRef: 'telegram:c', platform: 'telegram', format: 'photo',
    text: 'Пост', spec: {}, voice: {}, slopWarnings: [], media: criticMediaOf({ media: [{ url: POSTER }] }),
  };
  assert.match(criticUserPrompt(req), /## Зображення поста\n- постер мережі «Prompt»/);
  assert.doesNotMatch(criticUserPrompt({ ...req, media: null }), /Зображення поста/);
});

test('critic gate: web_fetch / extract_images remember the page\'s main image → lintPost sources and the critic prompt', async () => {
  const seen: CriticRequest[] = [];
  const gate = new CriticGate(
    {
      critic: { review: async (r: CriticRequest) => { seen.push(r); return { ok: false as const, error: 'x', runIds: [], costUsd: 0 }; } },
      plans: { updateSlot: async () => null as any },
    },
    { slotId: 's1', channelKey: '@chan', mode: 'approve', resourceRef: 'telegram:@chan', platform: 'telegram', voice: {} },
  );
  const [fetch, images] = gate.wrapTools([
    { name: 'web_fetch', execute: async ({ url }: { url: string }) => ({ url, title: 'T', text: 'Page text.', image: url.endsWith('/a') ? 'https://news.example/og.jpg' : null }) },
    { name: 'extract_images', execute: async () => ({ og_image: 'https://other.example/og.png', images: [] }) },
  ] as unknown as EditorTool[]);
  await fetch.execute({ url: 'https://news.example/a' }, {} as any);
  await fetch.execute({ url: 'https://news.example/b' }, {} as any);
  await images.execute({ url: 'https://not-read.example/c' }, {} as any);
  const s = await gate.groundingSources();
  assert.deepEqual(s.map((x) => [x.url, x.image]), [['https://news.example/a', 'https://news.example/og.jpg'], ['https://news.example/b', null]]);
  assert.deepEqual(gate.sources().map((x) => 'image' in x), [false, false], 'sources() keeps its T5 shape');

  await gate.check({ text: 'Пост', spec: { source: { url: 'https://news.example/a' }, media: [{ url: POSTER }] }, format: 'photo', warnings: [] });
  assert.deepEqual(seen[0].media, {
    images: [{ url: POSTER, poster: { title: 'Prompt', useFor: 'пост про один промпт або техніку промптингу' } }],
    sourceImage: 'https://news.example/og.jpg',
  });
});

test('T17: the critic is told how many page images a news album may use', () => {
  const m = criticMediaOf({ media: [{ url: 'https://news.example/a.jpg' }] }, 'https://news.example/og.jpg', ['https://news.example/og.jpg', 'https://news.example/a.jpg', 'https://news.example/b.jpg']);
  assert.equal(m?.sourceImageCount, 3);
  assert.match(criticMediaLines(m).join('\n'), /Головне зображення сторінки-джерела: https:\/\/news\.example\/og\.jpg \(ще 2 зі статті теж можна, напр\. для альбому\)/);
  const one = criticMediaLines(criticMediaOf({ media: [{ url: 'https://news.example/a.jpg' }] }, 'https://news.example/og.jpg', ['https://news.example/og.jpg'])).join('\n');
  assert.doesNotMatch(one, /ще \d/);
  assert.equal('sourceImageCount' in criticMediaOf({ media: [{ url: POSTER }] }, 'https://news.example/og.jpg')!, false, 'no list: T11 shape');
});

test('T17: the gate remembers the page images (web_fetch / extract_images) → lintPost sources, the critic, the stored sources', async () => {
  const updates: any[] = [];
  const seen: CriticRequest[] = [];
  const gate = new CriticGate(
    {
      critic: { review: async (r: CriticRequest) => { seen.push(r); return { ok: false as const, error: 'x', runIds: [], costUsd: 0 }; } },
      plans: { updateSlot: async (_id: string, p: unknown) => { updates.push(p); return null as any; } },
    },
    { slotId: 's1', channelKey: '@chan', mode: 'approve', resourceRef: 'telegram:@chan', platform: 'telegram', voice: {} },
  );
  const OG = 'https://news.example/og.jpg';
  const A = 'https://news.example/a.jpg';
  const [fetch, images, feed] = gate.wrapTools([
    { name: 'web_fetch', execute: async ({ url }: { url: string }) => ({ url, title: 'T', text: 'Page text.', published_at: '2026-10-12T08:00:00.000Z', image: OG, images: [OG, A] }) },
    { name: 'extract_images', execute: async () => ({ og_image: OG, images: [OG, A, 'https://news.example/b.jpg'] }) },
    { name: 'fetch_feed', execute: async () => ({ items: [{ link: 'https://feed.example/item/1', title: 'Feed item', date: '2026-10-12T07:00:00Z' }] }) },
  ] as unknown as EditorTool[]);
  await feed.execute({}, {} as any);
  await fetch.execute({ url: 'https://news.example/story' }, {} as any);
  const s = await gate.groundingSources();
  assert.deepEqual(s.find((x) => x.url === 'https://news.example/story')?.images, [OG, A]);
  assert.equal('images' in s.find((x) => x.url === 'https://feed.example/item/1')!, false, 'a feed item has no image info');
  await images.execute({ url: 'https://news.example/story' }, {} as any);
  assert.deepEqual((await gate.groundingSources()).find((x) => x.url === 'https://news.example/story')?.images, [OG, A, 'https://news.example/b.jpg']);

  const spec = { source: { url: 'https://news.example/story' }, media: [{ url: A }] };
  const stored = gate.storedSources(spec);
  assert.deepEqual(stored[0], { url: 'https://news.example/story', publishedAt: '2026-10-12T08:00:00.000Z', title: 'T', image: OG, images: [OG, A, 'https://news.example/b.jpg'] }, 'the cited page first');
  assert.equal(stored[1].url, 'https://feed.example/item/1');
  assert.equal('image' in stored[1], false);

  await gate.check({ text: 'Пост', spec, format: 'photo', warnings: [] });
  assert.equal(seen[0].media?.sourceImageCount, 3);
  assert.deepEqual(updates.at(-1).critic.sources, stored, 'the critic verdict on the slot carries what the run read');
});

test('T17: storedSourcesOf caps the stored size (entries, images, titles, URLs) and keeps the tier', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ url: `https://site${i}.example/a/${i}`, title: 'x'.repeat(500), images: Array.from({ length: 14 }, (_, k) => `https://cdn.example/${i}/${k}.jpg`) }));
  const out = storedSourcesOf([...many, { url: `https://long.example/${'a'.repeat(2100)}` }, { url: 'https://techcrunch.com/2026/10/12/story/', image: null }], 'https://techcrunch.com/2026/10/12/story');
  assert.equal(out.length, STORED_SOURCES_MAX);
  assert.deepEqual(out[0], { url: 'https://techcrunch.com/2026/10/12/story/', tier: 'media', image: null }, 'the cited page first, whatever its position');
  assert.ok(out.every((s) => (s.images?.length ?? 0) <= 10 && (s.title?.length ?? 0) <= 200));
  assert.ok(JSON.stringify(out).length < 8_000, `${JSON.stringify(out).length} chars`);
  assert.ok(!storedSourcesOf([{ url: `https://long.example/${'a'.repeat(2100)}` }]).length, 'an over-long URL is not stored');
  assert.deepEqual(storedSourcesOf([{ url: 'library://news/1', text: 'x' }]), [], 'a library row is not a page');
});

test('T17: parseSources reads the stored images back (and tolerates junk)', () => {
  assert.deepEqual(parseSources([{ url: 'https://a.example/x', image: 'https://a.example/og.jpg', images: ['https://a.example/og.jpg', 7, 'https://a.example/b.jpg'], tier: 'media' }]),
    [{ url: 'https://a.example/x', publishedAt: null, title: null, image: 'https://a.example/og.jpg', images: ['https://a.example/og.jpg', 'https://a.example/b.jpg'] }]);
  assert.deepEqual(parseSources([{ url: 'https://a.example/x', image: null }])?.[0].image, null);
  assert.equal('images' in parseSources([{ url: 'https://a.example/x' }])![0], false);
});
