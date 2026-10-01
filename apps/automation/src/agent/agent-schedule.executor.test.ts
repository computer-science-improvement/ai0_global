import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdPlacement, AdPlacementPorts } from './ad-placement';
import { AgentScheduleExecutor, channelRefFromDb } from './agent-schedule.executor';

const REF = { trackedId: '11111111-1111-1111-1111-111111111111', channelKey: '@space_ua', botId: 'bot-uuid' };
const ORDER = {
  id: 'o1', advertiser: 'Школа', sponsor_label: null,
  creative: { format: 'photo', body: [{ type: 'p', text: 'Курси англійської.' }], media: [{ url: 'https://cdn.example.com/a.jpg' }], cta: { url: 'https://school.ua', label: 'Записатись' } },
};

function ports(opts: { enabled?: boolean; card?: boolean; ref?: any; order?: any } = {}) {
  const calls: any[] = [];
  const p: AdPlacementPorts = {
    editorEnabled: () => opts.enabled ?? true,
    channelRef: async () => (opts.ref === undefined ? REF : opts.ref),
    card: async () => (opts.card === false ? null : { timezone: 'Europe/Kyiv', linkStyle: 'inline' } as any),
    reserveSlot: async (i) => { calls.push(['reserve', i]); return 'slot1'; },
    createScheduledPost: async (post) => { calls.push(['scheduled', post]); return { id: 'sp1' }; },
    findOrder: async () => (opts.order === undefined ? ORDER : opts.order),
    setPlacement: async (id, pl) => { calls.push(['placement', id, pl]); },
  };
  return { placement: new AdPlacement(p), calls };
}

const INPUT = { channelId: REF.trackedId, text: 'preview', scheduledAt: '2026-10-02T21:30:00Z', orderId: 'o1' };

test('editor enabled + channel card → reserved slot on the channel-local plan date, creative snapshot, order placed', async () => {
  const { placement, calls } = ports();
  const r = await placement.place(INPUT);
  assert.deepEqual(r, { kind: 'reserved_slot', id: 'slot1' });
  const reserve = calls.find((c) => c[0] === 'reserve')[1];
  assert.equal(reserve.channelKey, '@space_ua');
  assert.equal(reserve.planDate, '2026-10-03', '21:30Z is already the next day in Kyiv');
  assert.equal(reserve.format, 'photo');
  assert.deepEqual(reserve.sourceHints, ['ad_order:o1']);
  assert.equal(reserve.postSpec.cta.url, 'https://school.ua');
  assert.deepEqual(calls.find((c) => c[0] === 'placement'), ['placement', 'o1', { slotId: 'slot1', publishAt: new Date(INPUT.scheduledAt) }]);
  assert.ok(!calls.some((c) => c[0] === 'scheduled'));
});

test('EDITOR_ENABLED=false → SP2 scheduled_posts fallback with the rendered creative, #реклама, photo, button, channel bot', async () => {
  const { placement, calls } = ports({ enabled: false });
  const r = await placement.place(INPUT);
  assert.deepEqual(r, { kind: 'scheduled_post', id: 'sp1' });
  const post = calls.find((c) => c[0] === 'scheduled')[1];
  assert.equal(post.channelId, REF.trackedId);
  assert.equal(post.botId, 'bot-uuid');
  assert.ok(post.text.endsWith('#реклама'));
  assert.equal(post.mediaType, 'photo');
  assert.equal(post.mediaUrl, 'https://cdn.example.com/a.jpg');
  assert.deepEqual(post.buttons, [{ buttons: [{ label: 'Записатись', url: 'https://school.ua' }] }]);
  assert.deepEqual(calls.find((c) => c[0] === 'placement')[2].slotId, null);
  assert.ok(!calls.some((c) => c[0] === 'reserve'));
});

test('no editor card for the channel → fallback even when the editor is enabled', async () => {
  const { placement, calls } = ports({ card: false });
  const r = await placement.place(INPUT);
  assert.equal(r.kind, 'scheduled_post');
  assert.ok(!calls.some((c) => c[0] === 'reserve'));
});

test('order without creative → legacy text becomes the creative (still labelled)', async () => {
  const { placement, calls } = ports({ enabled: false, order: { ...ORDER, creative: null } });
  await placement.place({ ...INPUT, text: 'Простий текст' });
  const post = calls.find((c) => c[0] === 'scheduled')[1];
  assert.equal(post.text, 'Простий текст\n\n#реклама');
});

test('legacy action without orderId → plain text scheduled post (pre-008 behaviour) with the channel bot', async () => {
  const { placement, calls } = ports();
  const r = await placement.place({ channelId: 'c1', text: 'Sponsored', scheduledAt: '2030-01-01T00:00:00Z' });
  assert.deepEqual(r, { kind: 'scheduled_post', id: 'sp1' });
  const p = calls.find((c) => c[0] === 'scheduled')[1];
  assert.equal(p.text, 'Sponsored');
  assert.equal(p.sender, 'bot');
  assert.equal(p.botId, 'bot-uuid', 'the SP2 path used to send botId=null, which the worker rejects');
  assert.equal(p.mediaType, 'none');
  assert.deepEqual(p.buttons, []);
  assert.equal(p.scheduledAt, '2030-01-01T00:00:00Z');
});

test('unknown order → error (the action is marked failed by the service)', async () => {
  const { placement } = ports({ order: null });
  await assert.rejects(() => placement.place(INPUT), /not found/);
});

test('channelRefFromDb resolves by uuid or key and falls back to the default bot', async () => {
  const seen: any[] = [];
  const pool = { query: async (sql: string, params: any[]) => { seen.push({ sql, params }); return { rows: [{ id: 'u1', channel_key: '@k', bot_id: 'b1' }] }; } };
  assert.deepEqual(await channelRefFromDb(pool as any, '@k'), { trackedId: 'u1', channelKey: '@k', botId: 'b1' });
  assert.match(seen[0].sql, /is_default/);
  assert.match(seen[0].sql, /tc\.id::text = \$1 OR tc\.channel_key = \$1/);
});

test('AgentScheduleExecutor wires AdPlacement (legacy path through the scheduled posts repo)', async () => {
  const created: any[] = [];
  const posts = { create: async (p: any) => { created.push(p); return { id: 'sp9' }; } } as any;
  const pool = { query: async () => ({ rows: [] }) } as any;
  const exec = new AgentScheduleExecutor(posts, pool, { get: () => undefined } as any);
  const r = await exec.schedule({ channelId: 'c1', text: 'Sponsored', scheduledAt: '2030-01-01T00:00:00Z' });
  assert.deepEqual(r, { kind: 'scheduled_post', id: 'sp9' });
  assert.equal(created[0].channelId, 'c1');
});
