/** Spec 037 T11: the critic sees the post's images — network posters by name and use_for — and the source page's main image. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criticMediaLines, criticMediaOf } from './critic-media';
import { criticUserPrompt, type CriticRequest } from './critic.service';
import { CriticGate } from './critic-gate';
import type { EditorTool } from '../harness/tool';

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
