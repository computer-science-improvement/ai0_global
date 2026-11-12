import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCard, makeSpec } from '../../editor/post/testing/fixtures';
import { ToolFailure } from '../../editor/mcp/mcp-server';
import { ConnectorChatService } from '../chat/connector-chat.service';
import { ConnectorPostsService } from '../posts/connector-posts.service';
import type { ConnectorPostsStore } from '../posts/connector-posts.repository';
import { defaultNeedsApproval } from '../posts/default-approval';
import { ConnectorToolsFactoryImpl } from './connector-tools.factory';
import { parseTimeInput, timeOut } from './common';
import { buildReadTools } from './read-tools';
import { CARD_KINDS_ALLOWED, CARD_KINDS_REFUSED, OWNER_CONFIRMED_TOOLS, buildWriteTools, isCardKindAllowed } from './write-tools';
import { ownerInstruction, REPLAN_INSTRUCTION_MAX } from '../../editor/api/editor-ops.service';

const NOW = new Date('2026-11-12T10:00:00Z'); // 12:00 in Kyiv
const card = makeCard({ channelKey: '@chan', mode: 'live', postsPerDayMax: 2 });

function fakeStore() {
  const calls: Record<string, any[]> = { insertPrepared: [], insertPlanned: [], cancel: [], patchWritten: [], patchPlanned: [] };
  let slot: any = null;
  const store: ConnectorPostsStore & { calls: typeof calls; setSlot(s: any): void; busy: Date[]; count: number } = {
    calls, busy: [], count: 0,
    setSlot(s) { slot = s; },
    async getSlot() { return slot; },
    async insertPrepared(p) { calls.insertPrepared.push(p); return 'p-1'; },
    async insertPlanned(p) { calls.insertPlanned.push(p); return 'p-2'; },
    async patchPlanned(id, p) { calls.patchPlanned.push(p); return { ...slot, ...p, lockedBy: 'connector' }; },
    async patchWritten(id, p) { calls.patchWritten.push(p); return { ...slot, renderedPreview: p.fields?.renderedPreview ?? slot.renderedPreview, lockedBy: 'connector' }; },
    async cancel(id, error) { calls.cancel.push(error); return slot && ['planned', 'awaiting_approval', 'approved'].includes(slot.status) ? { ...slot, status: 'skipped' } : null; },
    async busyTimes() { return store.busy; },
    async countInRange() { return store.count; },
  };
  return store;
}

function posts(over: { mode?: any; store?: ReturnType<typeof fakeStore> } = {}) {
  const store = over.store ?? fakeStore();
  const approvals = { approved: [] as string[], rejected: [] as string[] };
  const svc = new ConnectorPostsService({
    store, now: () => NOW, card: async (k) => (k === '@chan' ? card : null), modeOf: async () => over.mode ?? 'approve',
    render: async (_c, spec) => ({ rendered: { messages: [{ method: 'sendMessage', params: {} }] as any, primary: 0, preview: `PREVIEW ${spec.title}` }, prepared: {} as any, cleanup: async () => {} }),
    approvals: {
      approve: async (id) => { approvals.approved.push(id); return { movedTo: null }; },
      reject: async (id) => { approvals.rejected.push(id); return { replacementId: null }; },
    },
  });
  return { svc, store, approvals };
}

const goodPost = () => makeSpec({ format: 'text', origin: 'original', media: undefined, source: undefined });
const tzAt = '2026-11-13 18:00';

// ── pure rules ──────────────────────────────────────────────────────────────

test('defaultNeedsApproval: only approve mode waits (D1)', () => {
  assert.equal(defaultNeedsApproval('approve'), true);
  assert.equal(defaultNeedsApproval('live'), false);
  assert.equal(defaultNeedsApproval('shadow'), false);
});

test('time input: ISO offset or channel-local wall time; output {at, local, tz}', () => {
  assert.equal(parseTimeInput('2026-11-13T18:00:00+02:00', 'Europe/Kyiv')?.toISOString(), '2026-11-13T16:00:00.000Z');
  assert.equal(parseTimeInput('2026-11-13 18:00', 'Europe/Kyiv')?.toISOString(), '2026-11-13T16:00:00.000Z');
  assert.equal(parseTimeInput('2026-07-01 18:00', 'Europe/Kyiv')?.toISOString(), '2026-07-01T15:00:00.000Z', 'summer offset');
  assert.equal(parseTimeInput('2026-02-30 10:00', 'Europe/Kyiv'), null);
  assert.equal(parseTimeInput('2026-11-13T18:00:00', 'Europe/Kyiv'), null, 'no offset, no space form');
  assert.equal(parseTimeInput('tomorrow', 'Europe/Kyiv'), null);
  assert.deepEqual(timeOut(new Date('2026-11-13T16:00:00Z'), 'Europe/Kyiv'), { at: '2026-11-13T16:00:00.000Z', local: '2026-11-13 18:00', tz: 'Europe/Kyiv' });
});

test('card kind allowlist: one constant; refused and unknown kinds are not applied', () => {
  assert.equal(CARD_KINDS_ALLOWED.length, 17);
  for (const k of CARD_KINDS_ALLOWED) assert.equal(isCardKindAllowed(k), true, k);
  for (const k of CARD_KINDS_REFUSED) assert.equal(isCardKindAllowed(k), false, k);
  assert.equal(isCardKindAllowed('something_new'), false);
  assert.deepEqual([...OWNER_CONFIRMED_TOOLS], ['approve_post', 'apply_card']);
});

test('ownerInstruction: bounded, one line, framed as data', () => {
  assert.equal(ownerInstruction(undefined), null);
  assert.equal(ownerInstruction('   '), null);
  const t = ownerInstruction(`a\n\n  b ${'x'.repeat(2000)}`)!;
  assert.match(t, /Owner instruction/);
  assert.ok(t.length < REPLAN_INSTRUCTION_MAX + 200);
  assert.ok(!t.includes('\n\n'));
});

// ── posts service ───────────────────────────────────────────────────────────

test('prepare_post: approve mode waits, live mode is approved; locked, owner-edited insert', async () => {
  const a = posts({ mode: 'approve' });
  const r1: any = await a.svc.prepare({ channel: '@chan', at: tzAt, post: goodPost() });
  assert.equal(r1.status, 'awaiting_approval');
  assert.equal(r1.needs_approval, true);
  assert.equal(r1.locked, true);
  assert.equal(r1.local, '2026-11-13 18:00');
  assert.deepEqual(r1.untrusted_fields, ['preview']);
  assert.equal(a.store.calls.insertPrepared[0].status, 'awaiting_approval');
  const b = posts({ mode: 'live' });
  const r2: any = await b.svc.prepare({ channel: '@chan', at: tzAt, post: goodPost() });
  assert.equal(r2.status, 'approved');
  const c = posts({ mode: 'live' });
  assert.equal(((await c.svc.prepare({ channel: '@chan', at: tzAt, post: goodPost(), needsApproval: true })) as any).status, 'awaiting_approval');
});

test('prepare_post: refusals (shadow/off, window, quiet hours, bad post) and warnings', async () => {
  for (const mode of ['shadow', 'off']) {
    await assert.rejects(posts({ mode }).svc.prepare({ channel: '@chan', at: tzAt, post: goodPost() }), /nothing is published/);
  }
  const { svc, store } = posts();
  await assert.rejects(svc.prepare({ channel: '@chan', at: '2026-11-12 12:02', post: goodPost() }), /too soon/);
  await assert.rejects(svc.prepare({ channel: '@chan', at: '2027-03-01 12:00', post: goodPost() }), /too far/);
  await assert.rejects(svc.prepare({ channel: '@chan', at: '2026-11-13 02:00', post: goodPost() }), /quiet hours/);
  await assert.rejects(svc.prepare({ channel: '@chan', at: 'nonsense', post: goodPost() }), /not a valid time/);
  await assert.rejects(svc.prepare({ channel: '@chan', at: tzAt, post: { format: 'text' } }), /not valid/);
  await assert.rejects(svc.prepare({ channel: '@nope', at: tzAt, post: goodPost() }), /Unknown channel/);
  assert.equal(store.calls.insertPrepared.length, 0);
  store.busy = [new Date('2026-11-13T16:20:00Z')];
  store.count = 2;
  const r: any = await svc.prepare({ channel: '@chan', at: tzAt, post: goodPost() });
  assert.equal(r.warnings.length, 2, 'min-gap and daily-cap are warnings, not refusals');
});

test('plan_post: a locked fixed-topic slot; shadow warns, off refuses; unknown format refused', async () => {
  const { svc, store } = posts({ mode: 'live' });
  const r: any = await svc.plan({ channel: '@chan', at: tzAt, topic: 'Webb telescope', angle: 'new image', notes: 'mention NASA' });
  assert.equal(r.status, 'planned');
  assert.equal(store.calls.insertPlanned[0].topic, 'Webb telescope');
  assert.ok(store.calls.insertPlanned[0].sourceHints.includes('owner_notes: mention NASA'));
  await assert.rejects(svc.plan({ channel: '@chan', at: tzAt, topic: 'x y z', format: 'hologram' }), /Unknown format/);
  await assert.rejects(posts({ mode: 'off' }).svc.plan({ channel: '@chan', at: tzAt, topic: 'x y z' }), /is off/);
  const shadow: any = await posts({ mode: 'shadow' }).svc.plan({ channel: '@chan', at: tzAt, topic: 'x y z' });
  assert.ok(shadow.warnings.some((w: string) => /shadow/.test(w)));
});

const slotOf = (over: any = {}) => ({
  id: 'p-1', channelKey: '@chan', kind: 'content', status: 'approved', resourceRef: null, scheduledAt: new Date('2026-11-13T16:00:00Z'),
  createdVia: null, lockedBy: null, renderedPreview: 'old', ...over,
});

test('update_post: refuses closed posts, the last 2 minutes, brief fields on written posts, text on planned ones', async () => {
  const s = fakeStore();
  const { svc } = posts({ store: s });
  s.setSlot(slotOf({ status: 'published' }));
  await assert.rejects(svc.update({ postId: 'p-1', at: tzAt }), /published/);
  s.setSlot(slotOf({ scheduledAt: new Date(NOW.getTime() + 90_000) }));
  await assert.rejects(svc.update({ postId: 'p-1', post: goodPost() }), /2 minutes/);
  s.setSlot(slotOf());
  await assert.rejects(svc.update({ postId: 'p-1', topic: 'new' }), /takes new text/);
  await assert.rejects(svc.update({ postId: 'p-1' }), /Nothing to change/);
  s.setSlot(slotOf({ status: 'planned' }));
  await assert.rejects(svc.update({ postId: 'p-1', post: goodPost() }), /no text yet/);
  s.setSlot(slotOf({ resourceRef: 'instagram:acc' }));
  await assert.rejects(svc.update({ postId: 'p-1', at: tzAt }), /another platform/);
});

test('update_post: re-lints and re-renders text; keeps the status; locks', async () => {
  const s = fakeStore();
  const { svc } = posts({ store: s });
  s.setSlot(slotOf());
  const r: any = await svc.update({ postId: 'p-1', post: goodPost() });
  assert.equal(r.status, 'approved');
  assert.equal(r.locked, true);
  assert.match(r.preview, /PREVIEW/);
  assert.equal(s.calls.patchWritten[0].fields.lintWarnings.length >= 0, true);
  await assert.rejects(svc.update({ postId: 'p-1', post: { format: 'text' } }), /not valid/);
});

test('cancel_post uses the connector skip error; reject_post is for agent posts only; approve needs awaiting', async () => {
  const s = fakeStore();
  const { svc, approvals } = posts({ store: s });
  s.setSlot(slotOf({ status: 'awaiting_approval' }));
  const c: any = await svc.cancel({ postId: 'p-1', reason: 'changed my mind' });
  assert.equal(c.status, 'skipped');
  assert.match(s.calls.cancel[0], /skipped by owner \(connector\)/);
  s.setSlot(slotOf({ status: 'published' }));
  await assert.rejects(svc.cancel({ postId: 'p-1' }), /only planned/);
  s.setSlot(slotOf({ status: 'awaiting_approval', createdVia: 'connector', lockedBy: 'connector' }));
  await assert.rejects(svc.reject({ postId: 'p-1' }), /cancel_post/);
  s.setSlot(slotOf({ status: 'awaiting_approval' }));
  await svc.reject({ postId: 'p-1', reason: 'off topic' });
  assert.deepEqual(approvals.rejected, ['p-1']);
  s.setSlot(slotOf({ status: 'approved' }));
  await assert.rejects(svc.approve({ postId: 'p-1' }), /not waiting/);
  s.setSlot(slotOf({ status: 'awaiting_approval' }));
  assert.equal(((await svc.approve({ postId: 'p-1' })) as any).status, 'approved');
  assert.deepEqual(approvals.approved, ['p-1']);
});

test('check_post saves nothing and reports lint', async () => {
  const { svc, store } = posts();
  const ok: any = await svc.check({ channel: '@chan', post: goodPost() });
  assert.equal(ok.saved, false);
  assert.equal(typeof ok.ok, 'boolean');
  const bad: any = await svc.check({ channel: '@chan', post: { nope: 1 } });
  assert.equal(bad.ok, false);
  assert.equal(store.calls.insertPrepared.length + store.calls.insertPlanned.length, 0);
});

// ── tool surface ────────────────────────────────────────────────────────────

const READ = ['list_channels', 'get_channel', 'list_schedule', 'get_post', 'get_problems', 'get_logs', 'get_run', 'list_agents', 'read_agent_chat', 'list_recent_posts', 'check_post'];
const WRITE = ['prepare_post', 'plan_post', 'update_post', 'cancel_post', 'reject_post', 'approve_post', 'replan_channel', 'talk_to_agent', 'apply_card', 'discard_card'];

function allTools(over: { cardsApi?: any; replan?: any; chat?: any } = {}) {
  const { svc } = posts();
  const chat = over.chat ?? { talk: async (i: any) => ({ talked: i }), read: async (i: any) => ({ read: i }) };
  const readPorts: any = {
    now: () => NOW, env: () => undefined, cards: async () => [card], card: async (k: string) => (k === '@chan' ? card : null), modeOf: async () => 'live',
    slo: { get: async () => null, history: async () => [] },
    health: async () => ({ connections: [], sources: [], budget: { lines: [], blocking: [], slotsHit: 0 }, stuck: [], problems: 0 }),
    queries: {
      inbox: async () => [], closedGroups: async () => [], approvals: async () => [], pauses: async () => [], readiness: async () => [],
      channelFacts: async () => ({}), upcoming: async () => [], schedule: async () => ({ rows: [], truncated: false }),
      slotDetail: async () => null, logs: async () => [], recentPosts: async () => [],
    },
    run: async () => null, agents: async () => [],
  };
  const writePorts: any = {
    now: () => NOW, cards: async () => [card], posts: svc, chat,
    replan: over.replan ?? (async () => ({ status: 'started' })),
    cardsApi: over.cardsApi ?? { get: async () => null, apply: async () => ({}), discard: async () => ({}) },
  };
  return { read: buildReadTools({ ports: readPorts, posts: svc, chat }), write: buildWriteTools(writePorts), readPorts };
}

test('every tool: name, scope and annotations (read-only vs destructive) and JSON schema with descriptions', () => {
  const { read, write } = allTools();
  assert.deepEqual(read.map((t) => t.name), READ);
  assert.deepEqual(write.map((t) => t.name), WRITE);
  for (const t of read) {
    assert.equal(t.scope, 'mcp:read', t.name);
    assert.equal(t.annotations?.readOnlyHint, true, t.name);
    assert.equal(t.annotations?.openWorldHint, false, t.name);
    assert.equal(t.annotations?.destructiveHint, undefined, t.name);
  }
  for (const t of write) {
    assert.equal(t.scope, 'mcp:write', t.name);
    assert.equal(t.annotations?.readOnlyHint, false, t.name);
    assert.equal(t.annotations?.destructiveHint, true, t.name);
  }
  for (const n of ['update_post', 'cancel_post', 'approve_post', 'discard_card']) assert.equal(write.find((t) => t.name === n)!.annotations?.idempotentHint, true, n);
  for (const n of ['prepare_post', 'plan_post', 'talk_to_agent']) assert.equal(write.find((t) => t.name === n)!.annotations?.idempotentHint, undefined, n);
  for (const t of [...read, ...write]) {
    assert.ok(t.description.length > 40, t.name);
    const s: any = t.inputSchema;
    assert.equal(s.type, 'object');
    for (const [k, v] of Object.entries<any>(s.properties ?? {})) assert.ok(v.description, `${t.name}.${k} has a description`);
  }
});

test('the factory filters tools by the grant scopes', async () => {
  const f = new ConnectorToolsFactoryImpl({
    repos: { channels: { list: async () => [], get: async () => null }, runs: { get: async () => null } }, ops: { replan: async () => ({}) }, chat: {},
    agentsSvc: { handles: async () => ({ agents: [] }), action: async () => ({ action: {} }), applyAction: async () => ({}), discardAction: async () => ({}) },
    approvals: { approve: async () => ({ movedTo: null }), reject: async () => ({ replacementId: null }) }, approval: { mode: async () => 'live' },
    agentInfra: { agents: { list: async () => [] }, channelKeyOf: async () => null }, health: { health: async () => ({}) },
    slo: { get: async () => null, history: async () => [] }, publish: {} as any, pool: {} as any,
  });
  const p = (scopes: string[]): any => ({ grantId: 'g', clientId: 'c', clientName: 'Claude', scopes: new Set(scopes) });
  assert.deepEqual((await f.tools(p(['mcp:read']))).map((t) => t.name), READ);
  assert.equal((await f.tools(p(['mcp:read', 'mcp:write']))).length, 21);
  assert.deepEqual((await f.tools(p([]))).length, 0);
});

const call = (tools: any[], name: string, args: any = {}) => tools.find((t) => t.name === name).call(args);

test('unknown channel lists the known keys; other platforms are refused', async () => {
  const { read } = allTools();
  await assert.rejects(call(read, 'get_channel', { channel: '@nope' }), (e: any) => e instanceof ToolFailure && /known channels: @chan/.test(e.message));
  await assert.rejects(call(read, 'get_channel', { channel: 'instagram:x' }), /Telegram channels only/);
  await assert.rejects(call(read, 'get_channel', {}), /channel is required/);
  const ok: any = await call(read, 'get_channel', { channel: 'chan' });
  assert.equal(ok.channel, '@chan', 'the @ may be left out');
});

test('read tools: validation errors are short tool errors; channel-tz time input', async () => {
  const { read, readPorts } = allTools();
  await assert.rejects(call(read, 'list_schedule', { hours: 9999 }), /Invalid input/);
  await assert.rejects(call(read, 'list_schedule', { from: 'soon' }), /not a valid time/);
  let seen: any;
  readPorts.queries.schedule = async (q: any) => { seen = q; return { rows: [], truncated: false }; };
  await call(read, 'list_schedule', { channel: '@chan', from: '2026-11-13 18:00' });
  assert.equal(seen.from.toISOString(), '2026-11-13T16:00:00.000Z');
  assert.equal(seen.limit, 100);
  await assert.rejects(call(read, 'get_logs', { level: 'loud' }), /Invalid input/);
  await assert.rejects(call(read, 'get_post', { post_id: 'nope' }), /No post/);
  await assert.rejects(call(read, 'get_run', { run_id: 'nope' }), /No run/);
});

test('list_schedule: truncated flag and untrusted fields; titles are cut', async () => {
  const { read, readPorts } = allTools();
  const row = (i: number) => ({
    id: `s${i}`, channelKey: '@chan', scheduledAt: new Date(NOW.getTime() + i * 3_600_000), status: 'planned', kind: 'content', format: 'text',
    topic: 'T'.repeat(5000), title: null, createdVia: i === 0 ? 'connector' : null, lockedBy: i === 0 ? 'connector' : null, resourceRef: null,
    scheduleRuleId: null, promo: false, slo: false, hints: [], mode: 'approve', legacy: false,
  });
  readPorts.queries.schedule = async () => ({ rows: [row(0), row(1)], truncated: true });
  const r: any = await call(read, 'list_schedule', {});
  assert.equal(r.truncated, true);
  assert.ok(r.hint);
  assert.equal(r.items[0].origin, 'connector');
  assert.equal(r.items[0].locked, true);
  assert.ok(r.items[0].title.length <= 200);
  assert.deepEqual(r.untrusted_fields, ['items[].title']);
  assert.deepEqual(Object.keys(r.items[0].at ? { at: 1 } : {}), ['at']);
});

test('get_post: reason from the catalogue, preview cut to 1,500, untrusted fields', async () => {
  const { read, readPorts } = allTools();
  readPorts.queries.slotDetail = async () => ({
    slot: { ...slotOf({ status: 'skipped' }), topic: 'x', angle: null, format: 'text', error: 'connector: canceled by owner', renderedPreview: 'P'.repeat(9000), postSpec: { body: 'B'.repeat(9000) }, lintWarnings: [], critic: null, approvedAt: null, ownerEdited: false, rejectReason: null },
    runs: [], published: null,
  });
  const r: any = await call(read, 'get_post', { post_id: 'p-1' });
  assert.ok(r.preview.length <= 1500);
  assert.ok(r.spec.body.length <= 1500);
  assert.ok(r.reason.detail.length <= 300);
  assert.ok(r.untrusted_fields.includes('preview'));
});

test('get_problems: sorted critical first, capped; filters by channel', async () => {
  const { read, readPorts } = allTools();
  readPorts.queries.inbox = async () => [{ id: 1, kind: 'x', title: 'warn thing', severity: 'warning', refId: null, createdAt: NOW }, { id: 2, kind: 'y', title: 'bad thing', severity: 'critical', refId: null, createdAt: NOW }];
  readPorts.queries.closedGroups = async () => [{ channelKey: '@chan', status: 'skipped', error: 'budget_blocked: cap', n: 4, last: NOW }];
  const r: any = await call(read, 'get_problems', {});
  assert.equal(r.problems[0].severity, 'critical');
  assert.ok(r.problems.some((p: any) => p.kind === 'closed_without_post'));
  assert.ok(r.untrusted_fields.includes('problems[].title'));
  const none = await call(allTools().read, 'get_problems', { channel: '@chan' });
  assert.equal((none as any).count, 0);
});

// ── write tools ─────────────────────────────────────────────────────────────

test('apply_card: only allowlisted kinds; refused kinds name the dashboard; unknown card and non-pending refused', async () => {
  const applied: string[] = [];
  const cards: Record<string, any> = {
    a: { id: 'a', kind: 'set_brief', status: 'pending', summary: 'S'.repeat(2000), chatId: null },
    b: { id: 'b', kind: 'set_network_mode', status: 'pending', summary: 'x', chatId: null },
    c: { id: 'c', kind: 'brand_new_kind', status: 'pending', summary: 'x', chatId: null },
    d: { id: 'd', kind: 'set_brief', status: 'applied', summary: 'x', chatId: null },
  };
  const { write } = allTools({ cardsApi: { get: async (id: string) => cards[id] ?? null, apply: async (id: string) => { applied.push(id); }, discard: async (id: string) => { applied.push(`discard:${id}`); } } });
  const ok: any = await call(write, 'apply_card', { card_id: 'a' });
  assert.equal(ok.applied, true);
  assert.ok(ok.summary.length <= 400);
  await assert.rejects(call(write, 'apply_card', { card_id: 'b' }), /dashboard/);
  await assert.rejects(call(write, 'apply_card', { card_id: 'c' }), /dashboard/);
  await assert.rejects(call(write, 'apply_card', { card_id: 'd' }), /not pending/);
  await assert.rejects(call(write, 'apply_card', { card_id: 'zzz' }), /No card/);
  assert.deepEqual(applied, ['a'], 'nothing else was applied');
  await call(write, 'discard_card', { card_id: 'b' });
  assert.deepEqual(applied, ['a', 'discard:b'], 'any kind may be discarded');
});

test('replan_channel reports started / replan_in_progress / editor_disabled / channel_off', async () => {
  for (const status of ['started', 'replan_in_progress', 'editor_disabled', 'channel_off']) {
    const { write } = allTools({ replan: async () => ({ status }) });
    const r: any = await call(write, 'replan_channel', { channel: '@chan', instruction: 'a launch post at 18:00' });
    assert.equal(r.status, status);
  }
  await assert.rejects(call(allTools().write, 'replan_channel', { channel: '@chan', instruction: 'x'.repeat(601) }), /Invalid input/);
  await assert.rejects(call(allTools().write, 'replan_channel', { channel: '@chan', day: 'yesterday' }), /Invalid input/);
});

test('talk_to_agent: bounds on the wait and the message', async () => {
  const { write } = allTools();
  await assert.rejects(call(write, 'talk_to_agent', { message: 'hi', wait_seconds: 101 }), /Invalid input/);
  await assert.rejects(call(write, 'talk_to_agent', { message: '' }), /Invalid input/);
  const r: any = await call(write, 'talk_to_agent', { message: 'hi', agent: '@x', channel: 'chan' });
  assert.equal(r.talked.channel, '@chan');
});

// ── chat service ────────────────────────────────────────────────────────────

function fakeChat(over: any = {}) {
  const sent: any[] = [];
  let running = false;
  const msgs: any[] = over.messages ?? [];
  const chat = {
    chats: new Map<string, any>(),
    async createChat(o: any) { const c = { id: 'c1', createdVia: o.createdVia, agentId: null }; chat.chats.set('c1', c); return c; },
    async validateSend() { return 'ok'; },
    async sendMessage(id: string, text: string, o: any) { sent.push({ id, text, o }); running = true; msgs.push({ id: msgs.length + 1, role: 'assistant', content: 'A'.repeat(9000), createdAt: NOW, agentId: null, actions: null, draftIds: [] }); await over.turn?.(); running = false; },
    async getChat(id: string) {
      const c = chat.chats.get(id); if (!c) throw new Error('nf');
      return { chat: c, messages: msgs, drafts: [], actions: [] };
    },
    isRunning: () => running,
  };
  return { chat, sent };
}

test('ConnectorChatService.talk: new chat is created via connector, turn is via connector, text is cut and marked untrusted', async () => {
  const { chat, sent } = fakeChat();
  const svc = new ConnectorChatService({ chat: chat as any, agents: { handles: async () => ['ai0'], byId: async () => new Map() }, sleep: async () => {} });
  const r: any = await svc.talk({ message: 'plan the week', agent: '@AI0', waitSeconds: 500 });
  assert.equal(chat.chats.get('c1').createdVia, 'connector');
  assert.equal(sent[0].o.via, 'connector');
  assert.equal(sent[0].text, '@ai0 plan the week');
  assert.ok(r.messages[0].text.length <= 4000);
  assert.ok(r.untrusted_fields.includes('messages[].text'));
  assert.ok(r.note.includes('Publishing is off'));
  await assert.rejects(svc.talk({ message: 'x', agent: 'ghost' }), /no agent @ghost/);
});

test('ConnectorChatService.talk: continues only connector chats; read can read any chat and waits a bounded time', async () => {
  const { chat } = fakeChat();
  chat.chats.set('dash', { id: 'dash', createdVia: null, agentId: null });
  chat.chats.set('c1', { id: 'c1', createdVia: 'connector', agentId: null });
  const sleeps: number[] = [];
  let polls = 0;
  (chat as any).isRunning = () => polls++ < 1000;
  const svc = new ConnectorChatService({ chat: chat as any, agents: { handles: async () => [], byId: async () => new Map() }, sleep: async (ms) => { sleeps.push(ms); } });
  await assert.rejects(svc.talk({ message: 'x', chatId: 'dash' }), /not started from Claude/);
  await assert.rejects(svc.talk({ message: 'x', chatId: 'nope' }), /No chat/);
  const r: any = await svc.read({ chatId: 'dash', waitSeconds: 9999 });
  assert.equal(sleeps.length, 90, 'read waits at most 90 s');
  assert.equal(r.running, true);
  assert.ok(r.hint);
});
