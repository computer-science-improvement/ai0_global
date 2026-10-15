import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criticDatesLines } from './critic-dates';
import { criticUserPrompt, type CriticRequest } from './critic.service';
import { CriticGate } from './critic-gate';
import type { EditorTool } from '../harness/tool';

const req = (o: Partial<CriticRequest> = {}): CriticRequest => ({
  channelKey: '@chan', slotId: 's1', mode: 'live', resourceRef: 'telegram:@chan', platform: 'telegram', format: 'text',
  text: 'Реліз уже завтра.', spec: {}, voice: {}, slopWarnings: [], ...o,
});

test('T5 critic prompt: the publish time in the resource zone, the source date and the first post of the story', () => {
  const u = criticUserPrompt(req({
    dates: { publishAt: '2026-10-08T11:00:00Z', timezone: 'Europe/Kyiv', sourcePublishedAt: '2026-10-06', sourceDateFrom: 'url', storyFirstPostAt: '2026-10-07T14:30:18Z' },
  }));
  assert.match(u, /Публікація: четвер, 08\.10\.2026 14:00 \(Europe\/Kyiv\)/);
  assert.match(u, /Дата джерела: 06\.10\.2026 \(з адреси статті\) — за 47 год до публікації\./);
  assert.match(u, /Перший пост цієї історії на ресурсі: середа, 07\.10\.2026 17:30 \(Europe\/Kyiv\)/);
  assert.ok(u.indexOf('Публікація:') > u.indexOf('## Слот') && u.indexOf('Публікація:') < u.indexOf('## Пост'), 'in the slot section');
  assert.doesNotMatch(criticUserPrompt(req()), /Публікація:/, 'no dates, no line');
});

test('T5 critic dates: an instant source date in the zone; days for old sources; DST-correct', () => {
  assert.deepEqual(criticDatesLines({ publishAt: '2026-10-25T21:30:00Z', timezone: 'Europe/Kyiv', sourcePublishedAt: '2026-10-21T07:00:00Z', sourceDateFrom: 'page' }), [
    'Публікація: неділя, 25.10.2026 23:30 (Europe/Kyiv). «Сьогодні», «завтра», «щойно» і дні тижня в пості рахуй від цієї дати.',
    'Дата джерела: середа, 21.10.2026 10:00 (Europe/Kyiv) — за 5 дн. до публікації.',
  ]);
});

test('T5 critic gate: remembers published_at of pages and feed items, hands them to lintPost and the critic', async () => {
  let seen: CriticRequest | null = null;
  const gate = new CriticGate(
    {
      critic: { review: async (r: CriticRequest) => { seen = r; return { ok: false as const, error: 'x', runIds: [], costUsd: 0 }; } },
      plans: { updateSlot: async () => null as any },
    },
    { slotId: 's1', channelKey: '@chan', mode: 'approve', resourceRef: 'telegram:@chan', platform: 'telegram', voice: {} },
  );
  const tools = gate.wrapTools([
    { name: 'web_fetch', execute: async () => ({ url: 'https://news.example/a/story-of-the-day', title: 'Story', text: 'Body', published_at: '2026-10-07T09:00:00.000Z' }) },
    { name: 'fetch_feed', execute: async () => ({ items: [{ title: 'Item', link: 'https://feed.example/item-one-two', date: 'Tue, 06 Oct 2026 10:00:00 GMT', snippet: 's' }] }) },
  ] as unknown as EditorTool[]);
  await tools[0].execute({ url: 'https://news.example/a/story-of-the-day' }, {} as any);
  await tools[1].execute({ url: 'https://feed.example/rss' }, {} as any);
  assert.deepEqual(gate.sources(), [
    { url: 'https://news.example/a/story-of-the-day', publishedAt: '2026-10-07T09:00:00.000Z', title: 'Story' },
    { url: 'https://feed.example/item-one-two', publishedAt: '2026-10-06T10:00:00.000Z', title: 'Item' },
  ]);

  await gate.check({ text: 't', spec: { source: { url: 'https://news.example/a/story-of-the-day' } }, format: 'text', warnings: [], publishAt: '2026-10-08T11:00:00Z', timezone: 'Europe/Kyiv' });
  assert.deepEqual(seen!.dates, { publishAt: '2026-10-08T11:00:00Z', timezone: 'Europe/Kyiv', sourcePublishedAt: '2026-10-07T09:00:00.000Z', sourceDateFrom: 'page' });

  await gate.check({ text: 't2', spec: { source: { url: 'https://blog.example/2026/10/05/unread-article' } }, format: 'text', warnings: [], publishAt: '2026-10-08T11:00:00Z', timezone: 'Europe/Kyiv' });
  assert.deepEqual(seen!.dates, { publishAt: '2026-10-08T11:00:00Z', timezone: 'Europe/Kyiv', sourcePublishedAt: '2026-10-05', sourceDateFrom: 'url' });

  await gate.check({ text: 't3', spec: {}, format: 'text', warnings: [] });
  assert.equal(seen!.dates, null, 'a platform post without a publish time');
});
