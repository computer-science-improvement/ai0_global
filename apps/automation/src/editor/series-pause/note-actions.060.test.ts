/**
 * Spec 060 T3 (unit): the card actions of an Inbox note — keys and labels, what the card shows and what the callback
 * carries, the silent-day notes naming their series, the health mute that lasts 7 days, and the agent-page API
 * (`GET/POST /api/agents/:handle/series-pauses`) against fakes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanActions, muteAction, parseNoteAction, pauseActions, pausedActions } from './note-actions';
import { inboxItem, inboxSource, type SourceDeps } from '../owner-bot/card-sources';
import { cardKeyboard } from '../owner-bot/owner-bot.service';
import { evaluateSilentDays, pauseTargets, type WatchSlot } from '../silent/silent-days';
import { AgentsService } from '../agents/agents.service';
import { ResourceHealthService, DISMISS_DAYS } from '../platform/resource-health.service';
import { pausedNote } from './series-breaker';
import type { SeriesPause } from './series-pauses.repository';

const ID = '3f2b8c1e-7a41-4d52-9b6e-0c1d2e3f4a5b';
const DAY = 86_400_000;

test('keys: every action parses back to what it names; foreign keys and resource pauses do not parse', () => {
  assert.deepEqual(pausedActions(ID).map((a) => [a.key, a.label]), [[`resume:${ID}`, 'Відновити'], [`keep:${ID}`, 'Залишити на паузі']]);
  assert.deepEqual(parseNoteAction(`resume:${ID}`), { type: 'resume', id: ID });
  assert.deepEqual(parseNoteAction(`keep:${ID}`), { type: 'keep', id: ID });
  const [p] = pauseActions([{ channelKey: '@c', key: 'series:Три новини: дня', label: 'Три новини: дня' }]);
  assert.equal(p.label, 'Пауза серії');
  assert.deepEqual(parseNoteAction(p.key), { type: 'pause', channelKey: '@c', seriesKey: 'series:Три новини: дня', label: 'Три новини: дня' });
  assert.equal(muteAction('telegram:@c').label, 'Заглушити на 7 днів');
  assert.deepEqual(parseNoteAction('mute:telegram:@c'), { type: 'mute', ref: 'telegram:@c' });
  for (const bad of ['read', 'open', 'resume:not-a-uuid', 'pause:{', 'pause:["@c","resource:telegram:@c","x"]', 'mute:', '']) assert.equal(parseNoteAction(bad), null, bad);
});

test('pause buttons: one for one series, a named one each for two, at most two, never a whole resource', () => {
  const t = (n: string) => ({ channelKey: '@c', key: `series:${n}`, label: n });
  assert.deepEqual(pauseActions([t('A')]).map((a) => a.label), ['Пауза серії']);
  assert.deepEqual(pauseActions([t('A'), t('B'), t('C')]).map((a) => a.label), ['Пауза: A', 'Пауза: B']);
  assert.deepEqual(pauseActions([t('A'), t('A')]).map((a) => a.label), ['Пауза серії'], 'the same series twice is one button');
  assert.deepEqual(pauseActions([{ channelKey: '@c', key: 'resource:telegram:@c', label: 'telegram:@c' }]), []);
  assert.equal(pauseActions([t('Дуже довга назва серії, що не влазить у кнопку')])[0].label, 'Пауза серії');
  assert.ok(pauseActions([t('Дуже довга назва серії, що не влазить у кнопку'), t('B')])[0].label.length <= 'Пауза: '.length + 24);
});

test('cleanActions drops what is not an action of ours', () => {
  assert.deepEqual(cleanActions(null), []);
  assert.deepEqual(cleanActions([{ key: `resume:${ID}`, label: 'x' }, { key: 'rm -rf', label: 'y' }, 3, { label: 'z' }]), [{ key: `resume:${ID}`, label: 'x' }]);
});

test('the card: the note\'s actions first, then Прочитано and Відкрити; the callback data carries only card id and index', () => {
  const it = inboxItem(41, { title: 't', body: null, severity: 'action', actions: pausedActions(ID) }, new Date());
  assert.deepEqual(it.buttons.map((b) => b.key), [`resume:${ID}`, `keep:${ID}`, 'read', 'open']);
  const kb = cardKeyboard({ id: 9, buttons: [...it.buttons.slice(0, 3), { key: 'open', label: 'Відкрити', url: 'https://x.example/app' }] });
  assert.deepEqual(kb[0].map((b: any) => b.data), ['oc:9:0', 'oc:9:1', 'oc:9:2']);
  assert.ok(JSON.stringify(kb).length < 300, 'no series name or resource ref in the callback data');
  assert.deepEqual(inboxItem(1, { title: 't', body: null, severity: 'action' }, new Date()).buttons.map((b) => b.key), ['read', 'open'], 'a note without actions is as before');
});

function sourceDeps(rows: any[], ran: string[], withActions = true): SourceDeps {
  return {
    pool: { query: async () => ({ rows }) } as any, approvals: {} as any, directives: {} as any, actions: {} as any, steering: {} as any, setup: {} as any, playbooks: {} as any,
    inbox: { markRead: async (ids) => { ran.push(`read:${ids}`); return 1; } }, setupSections: [],
    ...(withActions ? { noteActions: { run: async (id: number, key: string) => { ran.push(`run:${id}:${key}`); return '✅ Відновлено: Prompt'; } } } : {}),
  };
}

test('inbox source: a stored note\'s actions come back on the swept card; an action button runs through noteActions, Прочитано as before', async () => {
  const ran: string[] = [];
  const s = inboxSource(sourceDeps([{ id: '7', title: 't', body: 'b', severity: 'action', created_at: new Date(), actions: pausedActions(ID) }], ran));
  assert.deepEqual((await s.waiting(new Date()))[0].buttons.map((b) => b.key), [`resume:${ID}`, `keep:${ID}`, 'read', 'open']);
  assert.match(await s.act('7', `resume:${ID}`), /^✅ Відновлено: Prompt · /);
  assert.match(await s.act('7', 'read'), /^✓ Прочитано · /);
  assert.deepEqual(ran, [`run:7:resume:${ID}`, 'read:7']);
  await assert.rejects(s.act('7', 'whatever'), /unknown button/);
  await assert.rejects(inboxSource(sourceDeps([], ran, false)).act('7', `resume:${ID}`), /недоступно/);
});

// ── the silent-day notes name their series ────────────────────────────────

const REF = 'telegram:@c';
const slot = (o: Partial<WatchSlot> & { id: string }): WatchSlot => ({
  ref: REF, scheduledAt: new Date('2026-10-22T06:00:00Z'), updatedAt: new Date('2026-10-22T06:05:00Z'), status: 'skipped', error: 'no_fresh_item: x', format: 'text', topic: 'T',
  seriesName: null, scheduleRuleId: null, criticVerdict: null, fallback: null, ...o,
});

test('silent-day notes: series_missed and dark_day list the series that missed; a plain slot offers nothing', () => {
  assert.deepEqual(pauseTargets([slot({ id: 'a', seriesName: 'Prompt' }), slot({ id: 'b', seriesName: 'Prompt' }), slot({ id: 'c' }), slot({ id: 'd', scheduleRuleId: 'r1', topic: 'Ранок' })]), [
    { channelKey: '@c', key: 'series:Prompt', label: 'Prompt' },
    { channelKey: '@c', key: 'rule:r1', label: 'fixed slot "Ранок"' },
  ]);
  const res = [{ ref: REF, tz: 'Europe/Kyiv', minPerDay: 1 }];
  const evening = evaluateSilentDays({ now: new Date('2026-10-22T16:00:00Z'), resources: res, slots: [slot({ id: 'a', seriesName: 'Prompt' })] });
  assert.deepEqual(evening.map((a) => a.kind), ['dark_day'], 'merged into one note');
  assert.deepEqual(evening[0].pauses, [{ channelKey: '@c', key: 'series:Prompt', label: 'Prompt' }]);
  assert.deepEqual(pauseActions(evening[0].pauses).map((a) => a.label), ['Пауза серії']);
  const plain = evaluateSilentDays({ now: new Date('2026-10-22T16:00:00Z'), resources: res, slots: [slot({ id: 'p' })] });
  assert.deepEqual(plain[0].pauses, []);
});

test('critic streak note names the series of the rejected slots', () => {
  const rejected = (id: string, n: number, seriesName: string | null) => slot({
    id, seriesName, status: 'skipped', error: 'critic_rejected: reject', criticVerdict: 'reject', scheduledAt: new Date(`2026-10-22T0${n}:00:00Z`), updatedAt: new Date(`2026-10-22T0${n}:05:00Z`),
  });
  const slots = [rejected('1', 1, 'Prompt'), rejected('2', 2, 'Prompt'), rejected('3', 3, 'Prompt')];
  const a = evaluateSilentDays({ now: new Date('2026-10-22T08:00:00Z'), resources: [{ ref: REF, tz: 'Europe/Kyiv', minPerDay: 0 }], slots, streakN: 3 }).find((x) => x.kind === 'critic_reject_streak')!;
  assert.deepEqual(a.pauses.map((t) => t.key), ['series:Prompt']);
});

test('the series-paused note tells the owner where to resume it', () => {
  const p: SeriesPause = { id: ID, channelKey: '@c', key: 'series:Prompt', label: 'Prompt', cause: 'no_material', reason: 'x', streak: 3, pausedAt: new Date(), resumedAt: null, resumedBy: null };
  assert.match(pausedNote(p).body, /Overview → Paused series.*Telegram card/);
});

// ── the health mute lasts 7 days ──────────────────────────────────────────

function healthHarness(now: { t: Date }) {
  const store = new Map<string, any>();
  const posts: any[] = [];
  const h = new ResourceHealthService({
    catalog: { list: async () => [], access: async () => ({ state: 'no_access', detail: 'bot is not an admin' }) } as any,
    profiles: { get: async (r: string) => (store.has(r) ? { health: store.get(r) } : null), setHealth: async (r: string, v: any) => { store.set(r, v); return null; } } as any,
    inbox: { post: async (i: any) => { posts.push(i); return 1; }, postOnce: async (i: any) => { posts.push(i); return 1; } } as any,
    now: () => now.t,
  });
  return { h, store, posts };
}

test('health notes carry «Заглушити на 7 днів»; the mute ends after 7 days and the reminders come back', async () => {
  const now = { t: new Date('2026-10-01T09:00:00Z') };
  const { h, store, posts } = healthHarness(now);
  await h.check('telegram:@c');
  assert.deepEqual(posts[0].actions, [muteAction('telegram:@c')]);
  assert.equal(await h.dismiss('telegram:@c'), true);
  now.t = new Date(now.t.getTime() + (DISMISS_DAYS - 1) * DAY);
  await h.check('telegram:@c');
  assert.ok(store.get('telegram:@c').dismissedAt, 'still muted on day 6');
  assert.equal(posts.length, 1);
  now.t = new Date(now.t.getTime() + 2 * DAY);
  await h.check('telegram:@c');
  assert.equal(store.get('telegram:@c').dismissedAt, undefined, 'the mute is over after 7 days');
  assert.equal(posts.length, 2, 'the reminder is back');
  assert.deepEqual(posts[1].actions, [muteAction('telegram:@c')]);
});

// ── the agent page API ────────────────────────────────────────────────────

function agentsApi() {
  const mk = (id: string, over: Partial<SeriesPause> = {}): SeriesPause => ({
    id, channelKey: '@c1', key: 'series:Prompt', label: 'Prompt', cause: 'no_material', reason: 'no text', streak: 3,
    pausedAt: new Date('2026-10-20T10:00:00Z'), resumedAt: null, resumedBy: null, ...over,
  });
  const state: SeriesPause[] = [
    mk(ID), mk('11111111-1111-4111-8111-111111111111', { key: 'series:Old', label: 'Old', resumedAt: new Date('2026-10-21T10:00:00Z'), resumedBy: 'owner' }),
    mk('22222222-2222-4222-8222-222222222222', { channelKey: '@other', label: 'Elsewhere' }),
  ];
  const resumed: string[] = [];
  const agent = { id: 'a1', parentId: null, scope: 'resource', scopeId: 'telegram:@c1', handle: 'c1', kind: 'orchestrator' } as any;
  const svc = new AgentsService({
    pool: { query: async () => ({ rows: [] }) } as any,
    agents: { getByHandle: async (h: string) => (h === 'c1' ? agent : null), get: async () => null } as any,
    skills: {} as any, inbox: {} as any, setChannelMode: async () => undefined, runNow: async () => ({ started: false, what: '' }), memory: async () => [],
    pauses: {
      list: async (key: string) => state.filter((p) => p.channelKey.toLowerCase() === key.toLowerCase()),
      resume: async (id: string, via: string) => { resumed.push(`${id}:${via}`); const p = state.find((x) => x.id === id)!; p.resumedAt = new Date(); p.resumedBy = 'owner'; return { outcome: 'ok', changed: true, code: 'resumed' as const, pause: p }; },
      execute: async () => ({ outcome: 'ok', changed: true, code: 'resumed' as const }),
    },
  });
  return { svc, resumed };
}

test('GET series-pauses: the channel\'s open pauses and the last resumed ones, dates as ISO strings; another channel\'s are not shown', async () => {
  const { svc } = agentsApi();
  const r = await svc.seriesPauses('c1');
  assert.equal(r.channelKey, '@c1');
  assert.deepEqual(r.open.map((p) => [p.id, p.label, p.cause, p.streak, p.pausedAt]), [[ID, 'Prompt', 'no_material', 3, '2026-10-20T10:00:00.000Z']]);
  assert.deepEqual(r.recent.map((p) => [p.label, p.resumedBy]), [['Old', 'owner']]);
});

test('POST series-pauses {action: resume}: resumes a pause of this channel; unknown, other channel\'s, already resumed and malformed bodies are refused', async () => {
  const { svc, resumed } = agentsApi();
  const after = await svc.seriesPauseAction('c1', { action: 'resume', id: ID });
  assert.deepEqual(resumed, [`${ID}:dashboard`]);
  assert.deepEqual(after.open, []);
  await assert.rejects(svc.seriesPauseAction('c1', { action: 'resume', id: ID }), (e: any) => e.getStatus() === 409);
  await assert.rejects(svc.seriesPauseAction('c1', { action: 'resume', id: '22222222-2222-4222-8222-222222222222' }), (e: any) => e.getStatus() === 404);
  await assert.rejects(svc.seriesPauseAction('c1', { action: 'delete', id: ID }), (e: any) => e.getStatus() === 400);
  await assert.rejects(svc.seriesPauseAction('c1', { action: 'resume', id: 'nope' }), (e: any) => e.getStatus() === 400);
  await assert.rejects(svc.seriesPauseAction('nobody', { action: 'resume', id: ID }), (e: any) => e.getStatus() === 404);
  assert.equal(resumed.length, 1);
});
