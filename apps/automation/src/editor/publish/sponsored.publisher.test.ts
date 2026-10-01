import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESERVED_MAX_LATE_MS, SponsoredPublisher } from './sponsored.publisher';
import { ChannelPausedForEditorError } from './telegram-editor.publisher';
import { AD_LABEL } from '../post/sponsored';
import { makeCard } from '../post/testing/fixtures';

const NOW = new Date('2026-10-01T10:00:00Z');
const CREATIVE = { format: 'text', body: [{ type: 'p', text: 'Найкращий курс англійської.' }] };

function slot(over: Record<string, unknown> = {}) {
  return {
    id: 's1', planId: 'p1', channelKey: '@chan', scheduledAt: new Date(NOW.getTime() - 60_000), kind: 'reserved', format: 'text',
    topic: 'Реклама: Школа', angle: null, sourceHints: ['ad_order:o1'], isExperiment: false, status: 'running', attempts: 1,
    runId: null, publishedPostId: null, postSpec: CREATIVE, renderedPreview: null, error: null, ...over,
  } as any;
}

function setup(opts: { slots?: any[]; order?: any; card?: any; send?: (k: string, m: any[]) => Promise<any> } = {}) {
  const sent: any[] = [];
  const updates: any[] = [];
  const pubs: any[] = [];
  const marked: any[] = [];
  const notes: string[] = [];
  const recorded: string[] = [];
  const order = opts.order === undefined
    ? { id: 'o1', advertiser: 'Школа', sponsorLabel: 'ФОП Коваль', status: 'scheduled', creative: CREATIVE }
    : opts.order;
  const p = new SponsoredPublisher({
    plans: {
      claimDueReserved: async () => opts.slots ?? [slot()],
      updateSlot: async (id: string, patch: any) => { updates.push({ id, ...patch }); },
      insertPublication: async (i: any) => { pubs.push(i); return 900; },
    },
    channels: { get: async () => (opts.card === undefined ? makeCard() : opts.card) },
    publisher: { send: opts.send ?? (async (k: string, m: any[]) => { sent.push({ k, m }); return { messageIds: [55] }; }) },
    orders: {
      findBySlot: async () => order,
      markPublished: async (id: string, postId: number) => { marked.push({ id, postId }); },
    },
    recordPublish: (k: string) => { recorded.push(k); },
    notify: async (t: string) => { notes.push(t); },
  });
  return { p, sent, updates, pubs, marked, notes, recorded };
}

test('publishes a due reserved slot without an LLM: label last, ad publication, order published', async () => {
  const h = setup();
  const n = await h.p.publishDue(NOW);
  assert.equal(n, 1);
  assert.equal(h.sent.length, 1);
  const text: string = h.sent[0].m[0].text;
  assert.ok(text.endsWith(`Реклама. Замовник: ФОП Коваль\n${AD_LABEL}`), text);
  assert.equal(h.pubs[0].strategyType, 'ad');
  assert.equal(h.pubs[0].slotId, 's1');
  assert.equal(h.pubs[0].messageId, 55);
  assert.deepEqual(h.marked, [{ id: 'o1', postId: 900 }]);
  const last = h.updates.at(-1);
  assert.equal(last.status, 'published');
  assert.equal(last.publishedPostId, 900);
  assert.deepEqual(h.recorded, ['@chan']);
});

test('publishes even when the channel card is off (paid ad ignores editor mode) or missing', async () => {
  const off = setup({ card: makeCard({ mode: 'off' }) });
  await off.p.publishDue(NOW);
  assert.equal(off.sent.length, 1);
  const none = setup({ card: null });
  await none.p.publishDue(NOW);
  assert.equal(none.sent.length, 1);
});

test('paused channel → slot failed, owner alerted, nothing sent', async () => {
  const h = setup({ send: async () => { throw new ChannelPausedForEditorError('@chan'); } });
  await h.p.publishDue(NOW);
  assert.equal(h.updates.at(-1).status, 'failed');
  assert.match(h.updates.at(-1).error, /publish_paused/);
  assert.equal(h.marked.length, 0);
  assert.equal(h.notes.length, 1);
});

test('too late → failed (missed window), never posted hours after the agreed time', async () => {
  const h = setup({ slots: [slot({ scheduledAt: new Date(NOW.getTime() - RESERVED_MAX_LATE_MS - 60_000) })] });
  await h.p.publishDue(NOW);
  assert.equal(h.sent.length, 0);
  assert.equal(h.updates.at(-1).status, 'failed');
  assert.match(h.updates.at(-1).error, /missed/);
  assert.equal(h.notes.length, 1);
});

test('canceled order → slot skipped; missing order → failed', async () => {
  const c = setup({ order: { id: 'o1', advertiser: 'x', sponsorLabel: null, status: 'canceled', creative: CREATIVE } });
  await c.p.publishDue(NOW);
  assert.equal(c.sent.length, 0);
  assert.equal(c.updates.at(-1).status, 'skipped');
  const m = setup({ order: null });
  await m.p.publishDue(NOW);
  assert.equal(m.sent.length, 0);
  assert.equal(m.updates.at(-1).status, 'failed');
});

test('invalid creative snapshot (lint fails) → failed with the lint errors, nothing sent', async () => {
  const h = setup({ slots: [slot({ postSpec: { format: 'photo', body: [{ type: 'p', text: 'без фото' }] } })] });
  await h.p.publishDue(NOW);
  assert.equal(h.sent.length, 0);
  assert.equal(h.updates.at(-1).status, 'failed');
  assert.match(h.updates.at(-1).error, /media_count/);
});

test('Telegram error → failed once, no retry loop', async () => {
  const h = setup({ send: async () => { throw new Error('Telegram sendMessage failed: chat not found'); } });
  await h.p.publishDue(NOW);
  assert.equal(h.updates.at(-1).status, 'failed');
  assert.match(h.updates.at(-1).error, /chat not found/);
});

test('pin_24h order → the owner alert asks to pin the post for 24 h', async () => {
  const h = setup({ order: { id: 'o1', advertiser: 'Школа', sponsorLabel: null, status: 'scheduled', creative: CREATIVE, format: 'pin_24h' } });
  await h.p.publishDue(NOW);
  assert.equal(h.sent.length, 1);
  assert.match(h.notes[0], /закріпи/);
  const plain = setup();
  await plain.p.publishDue(NOW);
  assert.doesNotMatch(plain.notes[0], /закріпи/);
});
