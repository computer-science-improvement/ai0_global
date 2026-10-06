import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DraftsService, DraftsDeps } from './drafts.service';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import type { EditorDraft } from '../repo/editor-chat.repository';
import type { EditorSlot } from '../repo/editor-plans.repository';
import { ChannelPausedForEditorError } from '../publish/telegram-editor.publisher';

const NOW = new Date('2026-10-01T09:00:00Z'); // 12:00 Kyiv

/** In-memory fakes for every port of DraftsService. */
function setup(o: { card?: any; mine?: Array<{ channelKey: string; title: string | null }>; paused?: boolean; posted?: string[]; sendError?: Error; skipFails?: boolean; libraryText?: string } = {}) {
  const drafts = new Map<string, EditorDraft>();
  const slots = new Map<string, any>();
  const sent: any[] = [];
  const pubs: any[] = [];
  const cardsInserted: any[] = [];
  const reserved: any[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];
  const slotUpdates: any[] = [];
  const crossposts: any[] = [];
  let n = 0;
  const cards = new Map<string, any>(o.card ? [[o.card.channelKey, o.card]] : []);
  const d: DraftsDeps = {
    pool: { query: async () => ({ rows: o.libraryText ? [{ key: 'recipes', data: { description: o.libraryText } }] : [] }) } as any,
    repo: {
      insertDraft: async (x) => {
        const id = `d${++n}`;
        const dr: EditorDraft = { id, chatId: x.chatId, channelKey: x.channelKey, spec: x.spec, preview: x.preview, lint: x.lint, status: 'draft', scheduledAt: null, slotId: null, publishedPostId: null, error: null, createdAt: NOW, updatedAt: NOW };
        drafts.set(id, dr);
        return dr;
      },
      updateDraft: async (id, p) => {
        const cur = drafts.get(id);
        if (!cur) return null;
        const next = { ...cur, ...p } as EditorDraft;
        drafts.set(id, next);
        return next;
      },
      getDraft: async (id) => drafts.get(id) ?? null,
      findDraftBySlot: async (slotId) => [...drafts.values()].find((x) => x.slotId === slotId) ?? null,
      listDrafts: async () => [...drafts.values()],
      myChannels: async () => (o.mine ?? []).map((c) => ({ ...c, hasCard: cards.has(c.channelKey), mode: cards.get(c.channelKey)?.mode ?? null })),
    },
    channels: {
      get: async (k) => cards.get(k) ?? null,
      insertIfMissing: async (c) => { if (cards.has(c.channelKey)) return false; cards.set(c.channelKey, c); cardsInserted.push(c); return true; },
    },
    plans: {
      reserveSlot: async (i) => { const id = `slot${reserved.length + 1}`; reserved.push(i); slots.set(id, { ...i, id, status: 'planned' }); return id; },
      skipPlannedSlot: async (id) => {
        if (o.skipFails) return null;
        const s = slots.get(id);
        if (!s || s.status !== 'planned') return null;
        s.status = 'skipped'; skipped.push(id);
        return s;
      },
      updateSlot: async (id, p) => { slotUpdates.push([id, p]); },
      sourcePostedSince: async (_k, url) => (o.posted ?? []).includes(url),
      insertPublication: async (i) => { pubs.push(i); return 700 + pubs.length; },
    },
    publisher: { send: async (k, m) => { if (o.sendError) throw o.sendError; sent.push([k, m]); return { messageIds: [900] }; } },
    recordPublish: () => {},
    crosspost: { fanOut: async (r) => { crossposts.push(r); return []; } },
    isPaused: () => !!o.paused,
    notify: async (t) => { notes.push(t); },
    now: () => NOW,
  };
  return { svc: new DraftsService(d), drafts, slots, sent, pubs, cardsInserted, reserved, skipped, notes, slotUpdates, crossposts, cards };
}

const CARD = makeCard({ channelKey: '@chan', mode: 'shadow' });
const save = async (s: ReturnType<typeof setup>, spec: any = makeSpec(), channel = '@chan') => {
  const r: any = await s.svc.save({ chatId: 'chat-1', channel, spec });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.draft as EditorDraft;
};

test('save: validates with the channel card, stores preview + lint, lint errors are kept for the agent', async () => {
  const s = setup({ card: CARD });
  const ok: any = await s.svc.save({ chatId: 'chat-1', channel: '@chan', spec: makeSpec() });
  assert.equal(ok.ok, true);
  assert.equal(ok.lint.ok, true);
  assert.match(ok.draft.preview, /Телескоп Вебб/);
  assert.equal(ok.draft.status, 'draft');

  const bad: any = await s.svc.save({ chatId: 'chat-1', channel: '@chan', spec: makeSpec({ hashtags: ['мода'] }) });
  assert.equal(bad.ok, true);
  assert.equal(bad.lint.ok, false);
  assert.equal(bad.lint.errors[0].code, 'hashtag_not_in_vocabulary');

  const upd: any = await s.svc.save({ chatId: 'chat-1', channel: '@chan', spec: makeSpec({ title: 'Інший заголовок' }), draftId: ok.draft.id });
  assert.equal(upd.draft.id, ok.draft.id);
  assert.equal((upd.draft.spec as any).title, 'Інший заголовок');
});

test('save: default card for an own channel without a card (any hashtag, every format); unknown channel refused', async () => {
  const s = setup({ mine: [{ channelKey: '@mine', title: 'Мій канал' }] });
  const r: any = await s.svc.save({ chatId: null, channel: '@mine', spec: makeSpec({ hashtags: ['будь_що', 'ще'], format: 'photo' }) });
  assert.equal(r.ok, true);
  assert.equal(r.lint.ok, true, JSON.stringify(r.lint));
  assert.equal(r.card.title, 'Мій канал');
  assert.equal(r.card.formats.carousel, 1);
  const unknown: any = await s.svc.save({ chatId: null, channel: '@stranger', spec: makeSpec() });
  assert.equal(unknown.error, 'unknown_channel');
  const invalid: any = await s.svc.save({ chatId: null, channel: '@mine', spec: { format: 'photo' } });
  assert.equal(invalid.error, 'invalid_spec');
});

test('publish: guards (lint, paused, dedup 7 days, verbatim copy) then sends with strategy chat and marks the draft published', async () => {
  const lintFail = setup({ card: CARD });
  const bad = await save(lintFail, makeSpec({ hashtags: ['мода'] }));
  assert.equal(((await lintFail.svc.publish(bad.id)) as any).error, 'lint_failed');

  const paused = setup({ card: CARD, paused: true });
  assert.equal(((await paused.svc.publish((await save(paused)).id)) as any).error, 'channel_paused');

  const dup = setup({ card: CARD, posted: ['https://nasa.gov/ring'] });
  assert.equal(((await dup.svc.publish((await save(dup)).id)) as any).error, 'source_already_posted');
  const libDup = setup({ card: CARD, posted: ['library://facts/42'] });
  const lib = await save(libDup, makeSpec({ origin: 'library', library_ref: 'library://facts/42', source: undefined }));
  assert.equal(((await libDup.svc.publish(lib.id)) as any).error, 'library_item_already_posted');
  const copied = 'Телескоп Вебб показав туманність Кільце. На знімку видно оболонки газу, які зоря скинула тисячі років тому.';
  const verbatim = setup({ card: CARD, libraryText: copied });
  const v = await save(verbatim, makeSpec({ origin: 'library', library_ref: 'library://recipes/7', source: undefined, body: [{ type: 'p', text: copied }] }));
  assert.equal(((await verbatim.svc.publish(v.id)) as any).error, 'too_verbatim');
  for (const x of [lintFail, paused, dup, libDup, verbatim]) assert.equal(x.sent.length, 0);

  const s = setup({ card: CARD });
  const draft = await save(s);
  const r: any = await s.svc.publish(draft.id);
  assert.equal(r.ok, true);
  assert.equal(r.messageId, 900);
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.pubs[0], { channelKey: '@chan', messageId: 900, sourceUrl: 'https://nasa.gov/ring', title: 'Новий знімок туманності', tags: ['космос'], format: 'photo', slotId: null, strategyType: 'chat' });
  assert.equal(s.drafts.get(draft.id)!.status, 'published');
  assert.equal(s.drafts.get(draft.id)!.publishedPostId, 701);
  assert.equal(s.crossposts.length, 1, 'card with crosspost on → mirrors');
  assert.equal(((await s.svc.publish(draft.id)) as any).error, 'already_published');
});

test('publish: no mirrors without a real card; a Telegram failure marks the draft failed', async () => {
  const s = setup({ mine: [{ channelKey: '@mine', title: null }] });
  const draft = await save(s, makeSpec(), '@mine');
  assert.equal(((await s.svc.publish(draft.id)) as any).ok, true);
  assert.equal(s.crossposts.length, 0);

  const f = setup({ card: CARD, sendError: new ChannelPausedForEditorError('@chan') });
  const d2 = await save(f);
  const r: any = await f.svc.publish(d2.id);
  assert.equal(r.error, 'publish_failed');
  assert.match(r.details, /publish_paused/);
  assert.equal(f.drafts.get(d2.id)!.status, 'failed');
});

test('schedule: time window, minimal card + reserved slot, draft scheduled', async () => {
  const s = setup({ mine: [{ channelKey: '@mine', title: 'Мій канал' }] });
  const draft = await save(s, makeSpec(), '@mine');
  assert.equal(((await s.svc.schedule(draft.id, new Date(NOW.getTime() + 60_000))) as any).error, 'too_soon');
  assert.equal(((await s.svc.schedule(draft.id, new Date(NOW.getTime() + 61 * 86_400_000))) as any).error, 'too_far');

  const at = new Date('2026-10-02T16:00:00Z'); // tomorrow 19:00 Kyiv
  const r: any = await s.svc.schedule(draft.id, at);
  assert.equal(r.ok, true);
  assert.equal(r.local, '2026-10-02 19:00 (Київ)');
  assert.equal(s.cardsInserted.length, 1);
  assert.deepEqual([s.cardsInserted[0].mode, s.cardsInserted[0].title, s.cardsInserted[0].crosspost], ['off', 'Мій канал', false]);
  assert.deepEqual(s.cardsInserted[0].hashtags, []);
  assert.equal(s.reserved.length, 1);
  assert.equal(s.reserved[0].planDate, '2026-10-02');
  assert.equal(s.reserved[0].scheduledAt.toISOString(), at.toISOString());
  assert.equal(s.reserved[0].topic, 'Чат: Новий знімок туманності');
  assert.deepEqual(s.reserved[0].sourceHints, [`chat_draft:${draft.id}`]);
  assert.equal(s.reserved[0].postSpec.title, 'Новий знімок туманності');
  const after = s.drafts.get(draft.id)!;
  assert.deepEqual([after.status, after.slotId, after.scheduledAt!.toISOString()], ['scheduled', 'slot1', at.toISOString()]);
  assert.equal(s.sent.length, 0);

  // reschedule: the old slot is skipped, a new one reserved; the existing card is not touched again
  const r2: any = await s.svc.schedule(draft.id, new Date('2026-10-03T16:00:00Z'));
  assert.equal(r2.ok, true);
  assert.deepEqual(s.skipped, ['slot1']);
  assert.equal(s.drafts.get(draft.id)!.slotId, 'slot2');
  assert.equal(s.cardsInserted.length, 1);
});

test('schedule refuses a draft that does not lint; a channel with a card gets no new card', async () => {
  const s = setup({ card: CARD });
  const bad = await save(s, makeSpec({ hashtags: ['мода'] }));
  assert.equal(((await s.svc.schedule(bad.id, new Date('2026-10-02T16:00:00Z'))) as any).error, 'lint_failed');
  const good = await save(s);
  assert.equal(((await s.svc.schedule(good.id, new Date('2026-10-02T16:00:00Z'))) as any).ok, true);
  assert.equal(s.cardsInserted.length, 0);
});

test('cancel: slot skipped, draft canceled; publish-now of a scheduled draft skips its slot first', async () => {
  const s = setup({ card: CARD });
  const a = await save(s);
  await s.svc.schedule(a.id, new Date('2026-10-02T16:00:00Z'));
  const c: any = await s.svc.cancel(a.id);
  assert.equal(c.ok, true);
  assert.equal(s.drafts.get(a.id)!.status, 'canceled');
  assert.deepEqual(s.skipped, ['slot1']);

  const b = await save(s);
  await s.svc.schedule(b.id, new Date('2026-10-02T17:00:00Z'));
  const p: any = await s.svc.publish(b.id);
  assert.equal(p.ok, true);
  assert.deepEqual(s.skipped, ['slot1', 'slot2']);
  assert.equal(s.drafts.get(b.id)!.slotId, null);

  const busy = setup({ card: CARD, skipFails: true });
  const x = await save(busy);
  busy.drafts.set(x.id, { ...busy.drafts.get(x.id)!, status: 'scheduled', slotId: 'slotX' });
  assert.equal(((await busy.svc.cancel(x.id)) as any).error, 'slot_in_progress');
  assert.equal(((await busy.svc.publish(x.id)) as any).error, 'slot_in_progress');
  assert.equal(busy.sent.length, 0);
});

const slotOf = (s: ReturnType<typeof setup>, id: string, over: Partial<EditorSlot> = {}): EditorSlot => ({
  id, planId: 'p', channelKey: s.slots.get(id).channelKey, scheduledAt: s.slots.get(id).scheduledAt, kind: 'reserved',
  format: 'photo', topic: 't', angle: null, sourceHints: [], isExperiment: false, status: 'running', attempts: 1, runId: null,
  publishedPostId: null, postSpec: s.slots.get(id).postSpec, renderedPreview: null, error: null, ...over,
});

test('publishScheduled: publishes at the time through the same steps, slot + draft published', async () => {
  const s = setup({ mine: [{ channelKey: '@mine', title: 'Мій канал' }] });
  const draft = await save(s, makeSpec(), '@mine');
  const at = new Date('2026-10-02T16:00:00Z');
  await s.svc.schedule(draft.id, at);
  const ok = await s.svc.publishScheduled(slotOf(s, 'slot1'), new Date(at.getTime() + 30_000));
  assert.equal(ok, true);
  assert.equal(s.sent.length, 1);
  assert.equal(s.pubs[0].slotId, 'slot1');
  assert.equal(s.pubs[0].strategyType, 'chat');
  assert.equal(s.slotUpdates.find((u) => u[1].status === 'published')[1].publishedPostId, 701);
  assert.equal(s.drafts.get(draft.id)!.status, 'published');
  assert.equal(s.crossposts.length, 0, 'minimal card has crosspost off');
});

test('publishScheduled: late, paused or canceled → never sent; failures alert the owner and fail the draft', async () => {
  const late = setup({ card: CARD });
  const d1 = await save(late);
  await late.svc.schedule(d1.id, new Date('2026-10-02T16:00:00Z'));
  assert.equal(await late.svc.publishScheduled(slotOf(late, 'slot1'), new Date('2026-10-02T23:00:00Z')), false);
  assert.match(late.slotUpdates.at(-1)[1].error, /missed window/);
  assert.equal(late.drafts.get(d1.id)!.status, 'failed');
  assert.equal(late.notes.length, 1);

  const paused = setup({ card: CARD, paused: true });
  const d2 = await save(paused);
  paused.drafts.set(d2.id, { ...paused.drafts.get(d2.id)!, status: 'scheduled', slotId: 'slot9' });
  paused.slots.set('slot9', { channelKey: '@chan', scheduledAt: NOW, postSpec: makeSpec() });
  assert.equal(await paused.svc.publishScheduled(slotOf(paused, 'slot9'), NOW), false);
  assert.equal(paused.drafts.get(d2.id)!.status, 'failed');
  assert.match(paused.notes[0], /не вийшов: channel_paused/);

  const canceled = setup({ card: CARD });
  const d3 = await save(canceled);
  canceled.drafts.set(d3.id, { ...canceled.drafts.get(d3.id)!, status: 'canceled', slotId: 'slot7' });
  canceled.slots.set('slot7', { channelKey: '@chan', scheduledAt: NOW, postSpec: makeSpec() });
  assert.equal(await canceled.svc.publishScheduled(slotOf(canceled, 'slot7'), NOW), false);
  assert.deepEqual(canceled.slotUpdates.at(-1), ['slot7', { status: 'skipped', error: 'draft canceled' }]);
  for (const x of [late, paused, canceled]) assert.equal(x.sent.length, 0);
});

test('renderDraft: the Telegram messages of a draft for the preview card; broken specs render null', async () => {
  const { renderDraft } = await import('./drafts.service');
  const base: any = { id: 'd', chatId: 'c', channelKey: '@chan', preview: null, lint: null, status: 'draft', scheduledAt: null, slotId: null, publishedPostId: null, error: null, createdAt: new Date(), updatedAt: new Date() };
  const quiz = makeSpec({ format: 'quiz', body: [], media: [{ url: 'https://pdr.example/a.jpg' }], poll: { question: 'Хто?', options: ['А', 'Б'], correct_index: 0 } });
  const r = renderDraft({ ...base, spec: quiz }, makeCard({ title: 'Тест' }));
  assert.deepEqual(r.render!.messages.map((m) => m.method), ['sendPhoto', 'sendPoll']);
  assert.equal(r.render!.channelTitle, 'Тест');
  assert.equal(renderDraft({ ...base, spec: { nope: true } }, null).render, null);
});
