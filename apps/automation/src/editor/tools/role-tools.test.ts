import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoleTools, RoleToolDeps } from './role-tools';
import { makeCard, makeSpec } from '../post/testing/fixtures';

const NOW = new Date('2026-10-01T09:00:00Z'); // 12:00 Kyiv

function deps(over: Partial<RoleToolDeps['plans']> = {}, extra: Partial<RoleToolDeps> = {}) {
  const updates: any[] = [];
  const sent: any[] = [];
  const pubs: any[] = [];
  const recorded: string[] = [];
  const previews: string[] = [];
  const plans: any = {
    createPlan: async (...a: any[]) => { updates.push(['createPlan', ...a]); return 'plan-1'; },
    reservedSlots: async () => [],
    getSlot: async (id: string) => ({ id, channelKey: '@chan', status: 'running' }),
    updateSlot: async (id: string, p: any) => { updates.push([id, p]); },
    countPublishedSince: async () => 0,
    lastPostAt: async () => null,
    sourceAlreadyPosted: async () => false,
    recentTexts: async () => ['Рецепт борщу з пампушками'],
    insertPublication: async (i: any) => { pubs.push(i); return 501; },
    ...over,
  };
  const d: RoleToolDeps = {
    pool: { query: async () => ({ rows: [] }) } as any,
    plans,
    memory: { listActive: async () => [], add: async () => 1, retireByReviewer: async (_c: string, id: number) => id === 1 },
    channels: { setFormatWeights: async (_k: string, w: any) => w },
    publisher: { send: async (_k: string, m: any) => { sent.push(m); return { messageIds: [900] }; } },
    recordPublish: (k) => recorded.push(k),
    notifyPreview: async (_k, html) => { previews.push(html); },
    now: () => NOW,
    ...extra,
  };
  const tools = Object.fromEntries(buildRoleTools(d).map((t) => [t.name, t]));
  return { tools, updates, sent, pubs, recorded, previews };
}

const ctx = (mode: any = 'live', over: any = {}) => ({ runId: 'run-1', role: 'executor' as const, channelKey: '@chan', slotId: 'slot-1', extras: { card: makeCard({ mode, ...over }) } });

test('publish_post live: renders, sends, records publication, marks slot published', async () => {
  const { tools, sent, pubs, recorded, updates } = deps();
  const r: any = await tools.publish_post.execute({ spec: makeSpec() }, ctx());
  assert.equal(r.ok, true);
  assert.equal(r.message_id, 900);
  assert.equal(sent[0][0].method, 'sendPhoto');
  assert.deepEqual(pubs[0], { channelKey: '@chan', messageId: 900, sourceUrl: 'https://nasa.gov/ring', title: 'Новий знімок туманності', tags: ['космос'], format: 'photo', slotId: 'slot-1' });
  assert.deepEqual(recorded, ['@chan']);
  assert.equal(updates.at(-1)[1].status, 'published');
  assert.equal(updates.at(-1)[1].publishedPostId, 501);
});

test('publish_post shadow: stores preview, notifies, never sends', async () => {
  const { tools, sent, previews, updates } = deps();
  const r: any = await tools.publish_post.execute({ spec: makeSpec() }, ctx('shadow'));
  assert.deepEqual([r.ok, r.shadow], [true, true]);
  assert.equal(sent.length, 0);
  assert.equal(previews.length, 1);
  assert.equal(updates[0][1].status, 'shadowed');
});

test('guards: slot state, lint, similarity, dedup, cap, quiet, gap, off', async () => {
  const call = async (over: any, c = ctx(), spec = makeSpec()) => ((await deps(over).tools.publish_post.execute({ spec }, c)) as any).error;
  assert.equal(await call({ getSlot: async () => null }), 'slot_not_found');
  assert.equal(await call({ getSlot: async () => ({ channelKey: '@chan', status: 'published' }) }), 'slot_not_running');
  assert.equal(await call({}, ctx('off')), 'channel_off');
  assert.equal(await call({}, ctx(), makeSpec({ hashtags: ['мода'] })), 'lint_failed');
  assert.equal(await call({ recentTexts: async () => ['Телескоп Вебб показав туманність Кільце. На знімку видно оболонки газу, які зоря скинула тисячі років тому. NASA #космос'] }), 'too_similar');
  assert.equal(await call({ sourceAlreadyPosted: async () => true }), 'source_already_posted');
  assert.equal(await call({ countPublishedSince: async () => 5 }), 'daily_cap_reached');
  assert.equal(await call({}, ctx('live', { quietStartHour: 11, quietEndHour: 14 })), 'quiet_hours');
  assert.equal(await call({ lastPostAt: async () => new Date(NOW.getTime() - 10 * 60_000) }), 'min_gap');
});

test('shadow mode skips live-only guards (cap/quiet/gap)', async () => {
  const { tools } = deps({ countPublishedSince: async () => 99, lastPostAt: async () => NOW });
  const r: any = await tools.publish_post.execute({ spec: makeSpec() }, ctx('shadow', { quietStartHour: 11, quietEndHour: 14 }));
  assert.equal(r.ok, true);
});

test('skip_slot marks skipped with reason', async () => {
  const { tools, updates } = deps();
  await tools.skip_slot.execute({ reason: 'немає свіжих новин' }, ctx());
  assert.equal(updates[0][1].status, 'skipped');
  assert.match(updates[0][1].error, /немає свіжих/);
});

test('submit_plan validates and creates', async () => {
  const { tools, updates } = deps();
  const c = { ...ctx('shadow'), role: 'planner' as const, extras: { card: makeCard({ postsPerDayMin: 1, postsPerDayMax: 3 }), planDate: '2026-10-01' } };
  const bad: any = await tools.submit_plan.execute({ rationale: 'план на день тест', slots: [{ time: '03:00', format: 'photo', topic: 'Тема про космос', source_hints: [], is_experiment: false }] }, c);
  assert.equal(bad.error, 'plan_invalid');
  const good: any = await tools.submit_plan.execute({ rationale: 'план на день тест', slots: [{ time: '18:00', format: 'photo', topic: 'Тема про космос', source_hints: [], is_experiment: false }] }, c);
  assert.equal(good.ok, true);
  assert.equal(updates[0][0], 'createPlan');
  assert.equal(updates[0][2], '2026-10-01');
});

test('reviewer: memory cap, retire rules, weight step', async () => {
  const { tools } = deps();
  const c = { ...ctx(), role: 'reviewer' as const, slotId: null };
  for (let i = 0; i < 5; i++) assert.equal(((await tools.add_memory.execute({ kind: 'insight', text: 'Вікторини мають вищі перегляди' }, c)) as any).ok, true);
  assert.equal(((await tools.add_memory.execute({ kind: 'insight', text: 'Шостий запис перевищує ліміт' }, c)) as any).error, 'memory_limit');
  assert.equal(((await tools.retire_memory.execute({ id: 2, reason: 'owner entry' }, c)) as any).error, 'not_retirable');
  assert.equal(((await tools.set_format_weights.execute({ weights: { photo: 0.5 } }, c)) as any).error, 'step_too_big');
  assert.equal(((await tools.set_format_weights.execute({ weights: { video: 0.5 } }, c)) as any).error, 'unknown_format');
  assert.equal(((await tools.set_format_weights.execute({ weights: { album: 0.6 } }, c)) as any).ok, true);
});

// ── phase-2 formats (spec 009 T002) ─────────────────────────────────────────
const P2 = { formats: { text: 1, photo: 1, carousel: 1, longread: 1 } };
const carouselSpec = () => makeSpec({
  format: 'carousel', media: [],
  slides: [{ title: 'Перший', text: 'Телескоп зняв туманність у інфрачервоному світлі.' }, { title: 'Другий', text: 'Оболонки газу розлітаються від зорі.' }],
});
function fakeMedia(fail = false) {
  const calls: string[] = [];
  return {
    calls,
    media: {
      prepare: async (spec: any, key: any) => {
        calls.push(`prepare:${spec.format}:${key.slotId}`);
        if (fail) throw new Error('hosting down');
        return {
          prepared: spec.format === 'carousel' ? { slideUrls: ['https://cdn.example/1.png', 'https://cdn.example/2.png'] } : { longreadUrl: 'https://telegra.ph/x' },
          cleanup: async () => { calls.push('cleanup'); },
        };
      },
    },
  };
}

test('carousel in shadow: no media preparation, textual slide preview', async () => {
  const m = fakeMedia();
  const { tools, sent, updates } = deps({}, { media: m.media });
  const r: any = await tools.publish_post.execute({ spec: carouselSpec() }, ctx('shadow', P2));
  assert.equal(r.ok, true);
  assert.deepEqual(m.calls, []);
  assert.equal(sent.length, 0);
  assert.match(updates[0][1].renderedPreview, /Карусель: 2 слайди/);
});

test('carousel live: slides prepared, sent as a media group, cleaned up after the send', async () => {
  const m = fakeMedia();
  const { tools, sent, updates } = deps({}, { media: m.media });
  const r: any = await tools.publish_post.execute({ spec: carouselSpec() }, ctx('live', P2));
  assert.equal(r.ok, true);
  assert.deepEqual(sent[0][0].photos, ['https://cdn.example/1.png', 'https://cdn.example/2.png']);
  assert.deepEqual(m.calls, ['prepare:carousel:slot-1', 'cleanup']);
  assert.equal(updates.at(-1)[1].status, 'published');
});

test('longread live: Telegraph URL becomes preview + "Читати"; failures are recoverable errors', async () => {
  const spec = makeSpec({ format: 'longread', media: [], longread: { title: 'Про туманність Кільце', blocks: [{ type: 'p', text: 'Довгий текст про туманність.' }] } });
  const ok = deps({}, { media: fakeMedia().media });
  await ok.tools.publish_post.execute({ spec }, ctx('live', P2));
  assert.deepEqual(ok.sent[0][0].buttons[0], [{ text: 'Читати', url: 'https://telegra.ph/x' }]);

  const none = deps();
  assert.equal(((await none.tools.publish_post.execute({ spec }, ctx('live', P2))) as any).error, 'format_unavailable');
  const broken = deps({}, { media: fakeMedia(true).media });
  const r: any = await broken.tools.publish_post.execute({ spec }, ctx('live', P2));
  assert.equal(r.error, 'prepare_failed');
  assert.match(r.details, /hosting down/);
  assert.equal(broken.sent.length + none.sent.length, 0);
});

// ── cross-posting (spec 009 T003) ───────────────────────────────────────────
function fakeCrosspost(result: string[] | Error = []) {
  const calls: any[] = [];
  return { calls, crosspost: { fanOut: async (r: any) => { calls.push(r); if (result instanceof Error) throw result; return result; } } };
}

test('live publish fans out to mirrors after the slot is published, with prepared media', async () => {
  const cp = fakeCrosspost();
  const m = fakeMedia();
  const { tools, updates } = deps({}, { crosspost: cp.crosspost, media: m.media });
  const r: any = await tools.publish_post.execute({ spec: carouselSpec() }, ctx('live', P2));
  assert.equal(r.ok, true);
  assert.equal(cp.calls.length, 1);
  assert.equal(cp.calls[0].messageId, 900);
  assert.deepEqual(cp.calls[0].prepared.slideUrls, ['https://cdn.example/1.png', 'https://cdn.example/2.png']);
  assert.deepEqual(m.calls, ['prepare:carousel:slot-1', 'cleanup']); // slides stay hosted until the mirrors took them
  assert.equal(updates.at(-1)[1].status, 'published');
  assert.equal(r.crosspost_warnings, undefined);
});

test('mirror failures never fail the publish: recorded as a crosspost warning on the slot', async () => {
  const cp = fakeCrosspost(['crosspost: instagram: media expired']);
  const { tools, updates } = deps({}, { crosspost: cp.crosspost });
  const r: any = await tools.publish_post.execute({ spec: makeSpec() }, ctx());
  assert.equal(r.ok, true);
  assert.deepEqual(r.crosspost_warnings, ['crosspost: instagram: media expired']);
  assert.deepEqual(updates.at(-1), ['slot-1', { error: 'crosspost: instagram: media expired' }]);

  const boom = deps({}, { crosspost: fakeCrosspost(new Error('meta down')).crosspost });
  const r2: any = await boom.tools.publish_post.execute({ spec: makeSpec() }, ctx());
  assert.equal(r2.ok, true);
  assert.match(boom.updates.at(-1)[1].error, /^crosspost: meta down/);
});

test('no fan-out in shadow mode or when the card has crosspost=false', async () => {
  const shadow = fakeCrosspost();
  await deps({}, { crosspost: shadow.crosspost }).tools.publish_post.execute({ spec: makeSpec() }, ctx('shadow'));
  const off = fakeCrosspost();
  const r: any = await deps({}, { crosspost: off.crosspost }).tools.publish_post.execute({ spec: makeSpec() }, ctx('live', { crosspost: false }));
  assert.equal(r.ok, true);
  assert.equal(shadow.calls.length + off.calls.length, 0);
});
