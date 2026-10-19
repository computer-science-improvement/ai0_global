/**
 * Spec 012 T1 (AI0-237): owner-only routing, callback parsing and the confirm step, idempotent and stale taps, the
 * sources' buttons and actions, quiet hours and the hourly limit, the backlog rule, closing a card decided elsewhere,
 * the inbox card sink and /waiting. All against fakes: nothing reaches Telegram.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOwnerUpdate } from '../../publishers/admin-bot.service';
import { OwnerInbox, setInboxCardSink } from '../agents/owner-inbox';
import { BotApiError, type BotApi, type Keyboard } from './bot-api';
import { actionSource, approvalSource, directiveSources, setupSource, type CardSource, type SourceDeps, type WaitingItem } from './card-sources';
import type { NewCard, OwnerCard } from './owner-cards.repository';
import { OwnerBotService, SINCE_KEY, cardKeyboard, isQuiet, parseCallback, parseQuiet } from './owner-bot.service';
import { cardText, clip, plural } from './owner-text';

// ── fakes ──────────────────────────────────────────────────────────────────

class MemRepo {
  cards: OwnerCard[] = [];
  private seq = 0;
  constructor(private readonly clock: () => Date) {}
  async insert(c: NewCard) {
    if (this.cards.some((x) => x.kind === c.kind && x.refId === c.refId)) return null;
    const card: OwnerCard = {
      id: ++this.seq, kind: c.kind, refId: c.refId, status: 'queued', critical: c.critical ?? false, title: c.title, body: c.body ?? null,
      buttons: c.buttons, link: c.link ?? null, chatId: null, messageId: null, outcome: null, resolvedBy: null, attempts: 0, lastError: null,
      createdAt: this.clock(), sentAt: null, resolvedAt: null,
    };
    this.cards.push(card);
    return { ...card };
  }
  async get(id: number) { const c = this.cards.find((x) => x.id === id); return c ? { ...c } : null; }
  async live() { return this.cards.filter((c) => c.status === 'queued' || c.status === 'open').map((c) => ({ ...c })); }
  async queued(limit: number) {
    return this.cards.filter((c) => c.status === 'queued').sort((a, b) => Number(b.critical) - Number(a.critical) || a.id - b.id).slice(0, limit).map((c) => ({ ...c }));
  }
  async byRefs(kind: string, refs: string[]) { return this.cards.filter((c) => c.kind === kind && refs.includes(c.refId)).map((c) => ({ ...c })); }
  async requeue(id: number) {
    const c = this.cards.find((x) => x.id === id && (x.status === 'failed' || x.status === 'closed'));
    if (!c) return null;
    Object.assign(c, { status: 'queued', attempts: 0, outcome: null, chatId: null, messageId: null, sentAt: null });
    return { ...c };
  }
  async markCritical(id: number) { const c = this.cards.find((x) => x.id === id && x.status === 'queued'); if (c) c.critical = true; }
  async markSent(id: number, chatId: string, messageId: number) {
    const c = this.cards.find((x) => x.id === id && x.status === 'queued');
    if (c) Object.assign(c, { status: 'open', chatId, messageId, sentAt: this.clock() });
  }
  async markAttempt(id: number, error: string) {
    const c = this.cards.find((x) => x.id === id && x.status === 'queued');
    if (c) { c.attempts++; c.lastError = error; if (c.attempts >= 5) c.status = 'failed'; }
  }
  async resolve(id: number, status: 'done' | 'closed', outcome: string, by: string | null) {
    const c = this.cards.find((x) => x.id === id && (x.status === 'queued' || x.status === 'open'));
    if (!c) return null;
    Object.assign(c, { status, outcome, resolvedBy: by, resolvedAt: this.clock() });
    return { ...c };
  }
  async sentSince(since: Date) { return this.cards.filter((c) => c.sentAt && c.sentAt >= since).length; }
  async counts() {
    return { open: this.cards.filter((c) => c.status === 'open').length, queued: this.cards.filter((c) => c.status === 'queued').length, sentToday: 0, failed: 0 };
  }
}

class FakeApi implements BotApi {
  sent: Array<{ chatId: string; text: string; kb: Keyboard | null | undefined; id: number }> = [];
  edits: Array<{ chatId: string; messageId: number; text: string; kb: Keyboard | null | undefined }> = [];
  answers: Array<{ id: string; text?: string }> = [];
  failSend: Error | null = null;
  private msg = 100;
  async send(chatId: string, text: string, kb?: Keyboard | null) {
    if (this.failSend) throw this.failSend;
    const id = ++this.msg;
    this.sent.push({ chatId, text, kb, id });
    return id;
  }
  async edit(chatId: string, messageId: number, text: string, kb?: Keyboard | null) { this.edits.push({ chatId, messageId, text, kb }); }
  async answer(id: string, text?: string) { this.answers.push({ id, text }); }
}

/** app_settings only (cards_since). */
function settingsPool(init: Record<string, string> = {}) {
  const rows = new Map(Object.entries(init));
  return {
    rows,
    async query(sql: string, params: any[] = []) {
      if (/^SELECT value FROM app_settings/.test(sql)) return { rows: rows.has(params[0]) ? [{ value: rows.get(params[0]) }] : [] };
      if (/^INSERT INTO app_settings/.test(sql)) { rows.set(params[0], params[1]); return { rows: [] }; }
      if (/^DELETE FROM app_settings/.test(sql)) { rows.delete(params[0]); return { rows: [] }; }
      throw new Error(`unexpected query: ${sql}`);
    },
  } as any;
}

const item = (refId: string, since: string, p: Partial<WaitingItem> = {}): WaitingItem => ({
  refId, title: `Пост ${refId}`, body: 'текст', path: `/app/editor/slot/${refId}`, critical: false, since: new Date(since),
  buttons: [{ key: 'approve', label: '✅ Опублікувати' }, { key: 'reject', label: '❌ Відхилити' }, { key: 'open', label: 'Відкрити' }], ...p,
});

function fakeSource(kind = 'approval', o: { confirm?: boolean } = {}) {
  const src = {
    items: [] as WaitingItem[], acts: [] as Array<[string, string]>, expiredIds: new Set<string>(), fail: null as Error | null,
    kind, emoji: '📝', label: 'Пост на схвалення',
    async waiting() { return src.items; },
    async act(ref: string, key: string) {
      if (src.fail) throw src.fail;
      src.acts.push([ref, key]);
      src.items = src.items.filter((i) => i.refId !== ref);
      return key === 'approve' ? '✅ Схвалено · 12:00' : '❌ Відхилено · 12:00';
    },
    async expired(refs: string[]) { return new Set(refs.filter((r) => src.expiredIds.has(r))); },
  };
  if (o.confirm) src.items = [];
  return src;
}

function setup(o: { now?: string; env?: Record<string, string>; since?: string; sources?: CardSource[] } = {}) {
  let now = new Date(o.now ?? '2026-10-19T09:00:00Z'); // 12:00 Kyiv
  const clock = () => now;
  const repo = new MemRepo(clock);
  const api = new FakeApi();
  const src = fakeSource();
  const env: Record<string, string> = { TELEGRAM_OWNER_ID: '42', DASHBOARD_URL: 'https://dash.example/', ...o.env };
  const pool = settingsPool({ [SINCE_KEY]: o.since ?? '2026-10-19T00:00:00Z' });
  const bot = new OwnerBotService({ pool, repo: repo as any, api, sources: o.sources ?? [src as CardSource], env: (k) => env[k], now: clock });
  return { bot, repo, api, src, env, pool, setNow: (iso: string) => { now = new Date(iso); } };
}

const cb = (data: string, p: Partial<{ fromId: number; messageId: number }> = {}) =>
  ({ id: `cb-${data}`, fromId: p.fromId ?? 42, chatId: 42, chatType: 'private', messageId: p.messageId ?? 101, data });

// ── routing and parsing ────────────────────────────────────────────────────

test('owner-only: a private chat from the owner or an allowlisted id; never a group or a stranger', () => {
  assert.equal(isOwnerUpdate({ fromId: 42, chatType: 'private' }, '42', ''), true);
  assert.equal(isOwnerUpdate({ fromId: 7, chatType: 'private' }, '42', '5, 7'), true);
  assert.equal(isOwnerUpdate({ fromId: 42, chatType: 'group' }, '42', ''), false);
  assert.equal(isOwnerUpdate({ fromId: 42, chatType: 'supergroup' }, '42', '42'), false);
  assert.equal(isOwnerUpdate({ fromId: 9, chatType: 'private' }, '42', '5,7'), false);
  assert.equal(isOwnerUpdate({ fromId: null, chatType: 'private' }, '42', ''), false);
  assert.equal(isOwnerUpdate({ fromId: 42, chatType: 'private' }, null, ''), false);
});

test('callback data: oc:<card>:<button>[:y|:n], nothing else', () => {
  assert.deepEqual(parseCallback('oc:12:0'), { cardId: 12, idx: 0, confirm: null });
  assert.deepEqual(parseCallback('oc:12:1:y'), { cardId: 12, idx: 1, confirm: 'y' });
  assert.deepEqual(parseCallback('oc:12:1:n'), { cardId: 12, idx: 1, confirm: 'n' });
  for (const bad of ['oc:x:0', 'oc:12', 'oc:12:0:z', 'run:12', 'oc:12:0:y:extra']) assert.equal(parseCallback(bad), null, bad);
});

test('quiet hours: 23-8 Kyiv wraps midnight; off and garbage mean none', () => {
  const q = parseQuiet('23-8');
  assert.deepEqual(q, [23, 8]);
  assert.equal(isQuiet(new Date('2026-10-19T20:30:00Z'), q), true);  // 23:30 Kyiv
  assert.equal(isQuiet(new Date('2026-10-19T21:00:00Z'), q), true);  // 00:00
  assert.equal(isQuiet(new Date('2026-10-20T04:59:00Z'), q), true);  // 07:59
  assert.equal(isQuiet(new Date('2026-10-20T05:00:00Z'), q), false); // 08:00
  assert.equal(isQuiet(new Date('2026-10-19T09:00:00Z'), q), false); // 12:00
  assert.equal(isQuiet(new Date('2026-10-19T11:00:00Z'), parseQuiet('13-15')), true); // 14:00
  assert.equal(parseQuiet('off'), null);
  assert.equal(parseQuiet('5-5'), null);
  assert.equal(parseQuiet('25-3'), null);
});

test('text: escaped HTML, clipped body, the outcome line; Ukrainian plurals', () => {
  const t = cardText({ emoji: '📝', label: 'Пост', title: 'a <b> & c', body: 'x'.repeat(700), outcome: '✅ Схвалено' });
  assert.match(t, /a &lt;b&gt; &amp; c/);
  assert.ok(t.includes('…'));
  assert.match(t, /<i>✅ Схвалено<\/i>$/);
  assert.equal(clip('one two three', 9), 'one two…');
  assert.deepEqual([1, 2, 5, 11, 21, 22, 25].map((n) => plural(n, 'картка', 'картки', 'карток')),
    ['картка', 'картки', 'карток', 'карток', 'картка', 'картки', 'карток']);
});

test('keyboard: action buttons on one row, the dashboard link below', () => {
  const kb = cardKeyboard({ id: 7, buttons: [{ key: 'approve', label: 'A' }, { key: 'reject', label: 'R' }, { key: 'open', label: 'O', url: 'https://d/x' }] });
  assert.deepEqual(kb, [[{ text: 'A', data: 'oc:7:0' }, { text: 'R', data: 'oc:7:1' }], [{ text: 'O', url: 'https://d/x' }]]);
});

// ── the sweep ──────────────────────────────────────────────────────────────

test('backlog rule: items that waited before cards were switched on get no card by themselves', async () => {
  const { bot, src, api, repo } = setup({ since: '2026-10-19T08:00:00Z' });
  src.items = [item('old', '2026-10-19T07:00:00Z'), item('new', '2026-10-19T08:30:00Z')];
  const r = await bot.sweep();
  assert.deepEqual(r, { created: 1, closed: 0, sent: 1 });
  assert.deepEqual(repo.cards.map((c) => c.refId), ['new']);
  assert.equal(api.sent[0].chatId, '42');
  assert.match(api.sent[0].text, /Пост на схвалення/);
  assert.deepEqual(api.sent[0].kb![1], [{ text: 'Відкрити', url: 'https://dash.example/app/editor/slot/new' }]);
  // A second sweep sends nothing new.
  assert.deepEqual(await bot.sweep(), { created: 0, closed: 0, sent: 0 });
});

test('the first sweep stores cards_since; switching cards off clears it and sends nothing', async () => {
  const { bot, pool, env, src, api } = setup();
  pool.rows.delete(SINCE_KEY);
  src.items = [item('a', '2026-10-19T08:00:00Z')];
  await bot.sweep();
  assert.equal(pool.rows.get(SINCE_KEY), '2026-10-19T09:00:00.000Z');
  assert.equal(api.sent.length, 0, 'it waited before the switch-on');
  env.OWNER_BOT_CARDS = 'off';
  await bot.sweep();
  assert.equal(pool.rows.has(SINCE_KEY), false);
});

test('quiet hours hold non-critical cards; critical ones go; one line when they end', async () => {
  const { bot, src, api, setNow } = setup({ now: '2026-10-19T21:00:00Z' }); // 00:00 Kyiv
  src.items = [item('a', '2026-10-19T20:00:00Z'), item('b', '2026-10-19T20:10:00Z', { critical: true })];
  await bot.sweep();
  assert.deepEqual(api.sent.map((s) => s.text.includes('Пост b')), [true]);
  setNow('2026-10-20T05:01:00Z'); // 08:01 Kyiv
  await bot.sweep();
  assert.equal(api.sent[1].text, '🌙 Поки ви відпочивали: 1 картка');
  assert.match(api.sent[2].text, /Пост a/);
});

test('a queued card whose post comes due turns critical and skips quiet hours', async () => {
  const { bot, src, api, repo } = setup({ now: '2026-10-19T21:00:00Z' });
  src.items = [item('a', '2026-10-19T20:00:00Z')];
  await bot.sweep();
  assert.equal(api.sent.length, 0);
  src.items = [item('a', '2026-10-19T20:00:00Z', { critical: true })];
  await bot.sweep();
  assert.equal(api.sent.length, 1);
  assert.equal(repo.cards[0].critical, true);
});

test('hourly limit: at most OWNER_BOT_MAX_PER_HOUR non-critical cards an hour; critical ones go anyway', async () => {
  const { bot, src, api, setNow } = setup({ env: { OWNER_BOT_MAX_PER_HOUR: '2' } });
  src.items = [1, 2, 3].map((n) => item(`p${n}`, '2026-10-19T08:00:00Z'));
  await bot.sweep();
  assert.equal(api.sent.length, 2);
  src.items.push(item('urgent', '2026-10-19T08:30:00Z', { critical: true }));
  await bot.sweep();
  assert.equal(api.sent.length, 3);
  assert.match(api.sent[2].text, /Пост urgent/);
  setNow('2026-10-19T10:01:00Z');
  await bot.sweep();
  assert.equal(api.sent.length, 4);
});

test('closing: decided in the dashboard, or expired; buttons go', async () => {
  const { bot, src, api, repo } = setup();
  src.items = [item('a', '2026-10-19T08:00:00Z'), item('b', '2026-10-19T08:00:00Z')];
  await bot.sweep();
  src.items = [];
  src.expiredIds.add('b');
  const r = await bot.sweep();
  assert.equal(r.closed, 2);
  assert.deepEqual(repo.cards.map((c) => [c.status, c.outcome]), [['closed', 'Вирішено в дашборді'], ['closed', 'Минув термін']]);
  assert.equal(api.edits.length, 2);
  assert.equal(api.edits[0].kb, null);
  assert.match(api.edits[1].text, /Минув термін/);
});

test('a source that throws neither closes its cards nor stops the others', async () => {
  const other = fakeSource('directive');
  const broken = { ...fakeSource('approval'), async waiting(): Promise<WaitingItem[]> { throw new Error('db down'); } };
  const { bot, repo, api } = setup({ sources: [broken as CardSource, other as CardSource] });
  await repo.insert({ kind: 'approval', refId: 'x', title: 't', buttons: [] });
  repo.cards[0].status = 'open';
  other.items = [item('d', '2026-10-19T08:00:00Z')];
  await bot.sweep();
  assert.equal(repo.cards.find((c) => c.refId === 'x')!.status, 'open');
  assert.equal(api.sent.length, 1);
});

test('a failed send is retried and fails after 5 attempts', async () => {
  const { bot, src, api, repo } = setup();
  src.items = [item('a', '2026-10-19T08:00:00Z')];
  api.failSend = new BotApiError('Bad Request: chat not found', 400);
  for (let i = 0; i < 6; i++) await bot.sweep();
  assert.equal(repo.cards[0].status, 'failed');
  assert.equal(repo.cards[0].attempts, 5);
});

// ── buttons ────────────────────────────────────────────────────────────────

test('a tap runs the action once, puts the outcome on the card and removes the buttons; a second tap is "already decided"', async () => {
  const { bot, src, api, repo } = setup();
  src.items = [item('a', '2026-10-19T08:00:00Z')];
  await bot.sweep();
  const id = repo.cards[0].id;
  await bot.callback(cb(`oc:${id}:0`));
  assert.deepEqual(src.acts, [['a', 'approve']]);
  assert.equal(repo.cards[0].status, 'done');
  assert.equal(repo.cards[0].resolvedBy, 'telegram:42');
  assert.match(api.edits.at(-1)!.text, /✅ Схвалено/);
  assert.equal(api.edits.at(-1)!.kb, null);
  assert.equal(api.answers.at(-1)!.text, '✅ Схвалено · 12:00');
  await bot.callback(cb(`oc:${id}:1`));
  assert.equal(src.acts.length, 1);
  assert.equal(api.answers.at(-1)!.text, 'Вже вирішено');
  // The sweep does not touch a card decided here.
  await bot.sweep();
  assert.equal(repo.cards[0].outcome, '✅ Схвалено · 12:00');
});

test('a refused action shows the reason as a toast and on the card, and keeps the buttons', async () => {
  const { bot, src, api, repo } = setup();
  src.items = [item('a', '2026-10-19T08:00:00Z')];
  await bot.sweep();
  src.fail = Object.assign(new Error('x'), { response: { error: 'not_open', details: 'the set is active' } });
  await bot.callback(cb(`oc:${repo.cards[0].id}:0`));
  assert.equal(api.answers.at(-1)!.text, '❌ the set is active');
  assert.match(api.edits.at(-1)!.text, /Не вдалося: the set is active/);
  assert.ok(api.edits.at(-1)!.kb?.length);
  assert.equal(repo.cards[0].status, 'open');
});

test('confirm: the first tap asks, Скасувати restores the buttons, Так runs it', async () => {
  const src = fakeSource('setup');
  const { bot, api, repo } = setup({ sources: [src as CardSource] });
  src.items = [item('p1', '2026-10-19T08:00:00Z', {
    buttons: [{ key: 'apply_all', label: 'Застосувати все', confirm: 'Так, застосувати все' }, { key: 'discard', label: 'Відхилити' }],
  })];
  await bot.sweep();
  const id = repo.cards[0].id;
  await bot.callback(cb(`oc:${id}:0`));
  assert.equal(src.acts.length, 0);
  assert.deepEqual(api.edits.at(-1)!.kb, [[{ text: 'Так, застосувати все', data: `oc:${id}:0:y` }, { text: 'Скасувати', data: `oc:${id}:0:n` }]]);
  await bot.callback(cb(`oc:${id}:0:n`));
  assert.deepEqual(api.edits.at(-1)!.kb, cardKeyboard(repo.cards[0]));
  assert.equal(src.acts.length, 0);
  await bot.callback(cb(`oc:${id}:0:y`));
  assert.deepEqual(src.acts, [['p1', 'apply_all']]);
});

test('an unknown card or a URL button only answers the tap', async () => {
  const { bot, api, src, repo } = setup();
  await bot.callback(cb('oc:999:0'));
  assert.equal(api.answers.at(-1)!.text, 'Картку не знайдено');
  src.items = [item('a', '2026-10-19T08:00:00Z')];
  await bot.sweep();
  await bot.callback(cb(`oc:${repo.cards[0].id}:2`));
  assert.equal(src.acts.length, 0);
});

// ── inbox notes ────────────────────────────────────────────────────────────

test('inbox sink: an action note becomes a card in its Telegram wording; info and directive notes are swallowed; off falls back', async () => {
  const { bot, repo, api, env } = setup({ sources: [] });
  assert.equal(await bot.inboxNote(1, { kind: 'x', title: 'EN title', severity: 'info' }), true);
  assert.equal(await bot.inboxNote(2, { kind: 'x', title: 'EN', severity: 'action', refType: 'directive', refId: 'd' }), true);
  assert.equal(repo.cards.length, 0);
  assert.equal(await bot.inboxNote(3, { kind: 'x', title: 'EN', body: 'b', severity: 'action', alert: { title: 'UA заголовок', body: 'UA тіло' } }), true);
  assert.equal(repo.cards[0].title, 'UA заголовок');
  assert.equal(repo.cards[0].critical, false);
  assert.equal(api.sent.length, 0, 'an action card waits for the sweep');
  assert.equal(await bot.inboxNote(4, { kind: 'x', title: 'Connection broken', severity: 'critical' }), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(api.sent.length, 1, 'a critical card goes at once');
  env.OWNER_BOT_CARDS = 'off';
  assert.equal(await bot.inboxNote(5, { kind: 'x', title: 'EN', severity: 'action' }), false);
});

test('OwnerInbox: the sink replaces the alert; false or a throw falls back to it', async () => {
  const alerts: string[] = [];
  const pool = { query: async () => ({ rows: [{ id: 7 }] }) } as any;
  const inbox = new OwnerInbox(pool, async (t) => { alerts.push(t); });
  try {
    setInboxCardSink(async () => true);
    await inbox.post({ kind: 'k', title: 't', severity: 'action' });
    assert.equal(alerts.length, 0);
    setInboxCardSink(async () => false);
    await inbox.post({ kind: 'k', title: 't', severity: 'action' });
    setInboxCardSink(async () => { throw new Error('x'); });
    await inbox.post({ kind: 'k', title: 't', severity: 'action' });
    assert.equal(alerts.length, 2);
  } finally {
    setInboxCardSink(null);
  }
});

// ── commands ───────────────────────────────────────────────────────────────

test('/waiting sends the backlog now (quiet hours aside), 10 at a time, and says what is left', async () => {
  const { bot, src, api } = setup({ now: '2026-10-19T21:00:00Z', since: '2026-10-19T20:00:00Z' });
  src.items = Array.from({ length: 12 }, (_, n) => item(`b${n}`, `2026-10-18T10:${String(n).padStart(2, '0')}:00Z`));
  assert.equal(await bot.waitingNow(), 'Надіслано 10. Ще чекає: 2 — /waiting ще раз.');
  assert.match(api.sent[0].text, /Пост b0/);
  assert.equal(await bot.waitingNow(), 'Надіслано 2. Це все.');
  src.items = [];
  assert.equal(await bot.waitingNow(), 'Нічого не чекає ✓');
});

test('/status counts what waits by kind; unknown commands are left to the admin bot', async () => {
  const { bot, src, api } = setup();
  src.items = [item('a', '2026-10-19T08:00:00Z'), item('b', '2026-10-19T08:00:00Z')];
  assert.equal(await bot.command({ chatId: 42, chatType: 'private', fromId: 42, text: '/status' }), true);
  assert.match(api.sent.at(-1)!.text, /Пост на схвалення: 2/);
  assert.equal(await bot.command({ chatId: 42, chatType: 'private', fromId: 42, text: '/nope' }), false);
  assert.equal(await bot.command({ chatId: 42, chatType: 'private', fromId: 42, text: '/today' }), false, 'no report yet');
  assert.deepEqual(bot.help().map((l) => l.split(' ')[0]), ['/status', '/waiting']);
});

test('the test card closes with its one button', async () => {
  const { bot, api, repo } = setup({ sources: [] });
  assert.deepEqual(await bot.testCard(), { sent: true });
  await bot.callback(cb(`oc:${repo.cards[0].id}:0`));
  assert.equal(repo.cards[0].status, 'done');
  assert.match(api.edits.at(-1)!.text, /✅ Працює/);
});

// ── sources against fakes ──────────────────────────────────────────────────

function deps(rows: any[] = [], calls: string[] = []): SourceDeps {
  const rec = (name: string) => async (...a: any[]) => { calls.push(`${name}(${a.map((x) => JSON.stringify(x)).join(',')})`); return {} as any; };
  return {
    pool: { query: async () => ({ rows }) } as any,
    approvals: { approve: async (id) => { calls.push(`approve(${id})`); return { movedTo: null }; }, reject: rec('reject') },
    directives: { decide: rec('decide'), ownerDecision: rec('ownerDecision') },
    actions: { apply: rec('apply'), discard: rec('discard') },
    steering: { activate: rec('activate'), discard: rec('steerDiscard') },
    setup: {
      apply: async (id, body) => { calls.push(`setupApply(${id},${JSON.stringify(body)})`); return { applied: ['schedule'], failed: null, changedSinceAnalysis: ['formatting'] }; },
      discard: rec('setupDiscard'),
    },
    playbooks: { decide: rec('pbDecide') },
    inbox: { markRead: async () => 1 },
    setupSections: ['formatting', 'schedule'],
  };
}

test('approval source: a post due within 2 hours is critical; approve and reject call the service', async () => {
  const calls: string[] = [];
  const now = new Date('2026-10-19T09:00:00Z');
  const s = approvalSource(deps([
    { id: 's1', channel_key: '@a', topic: 'T', rendered_preview: 'html', scheduled_at: new Date('2026-10-19T10:30:00Z'), channel_title: 'A', sent_at: new Date('2026-10-19T06:00:00Z') },
    { id: 's2', channel_key: '@a', topic: null, rendered_preview: null, scheduled_at: new Date('2026-10-19T15:00:00Z'), channel_title: null, sent_at: new Date('2026-10-19T06:00:00Z') },
  ], calls));
  const items = await s.waiting(now);
  assert.deepEqual(items.map((i) => i.critical), [true, false]);
  assert.equal(items[0].path, '/app/editor/slot/s1');
  assert.deepEqual(items[0].buttons.map((b) => b.key), ['approve', 'reject', 'open']);
  assert.match(await s.act('s1', 'approve'), /^✅ Схвалено · /);
  assert.match(await s.act('s1', 'reject'), /^❌ Відхилено · /);
  assert.deepEqual(calls, ['approve(s1)', 'reject("s1",{})']);
  await assert.rejects(s.act('s1', 'open'));
});

test('directive sources: awaiting_owner decides; a contested card strips its ref to uphold or accept the refusal', async () => {
  const calls: string[] = [];
  const [dir, contested] = directiveSources(deps([{ id: 'd1', kind: 'tone', body: 'B', rationale: 'R', resolution: 'no', created_at: new Date(), contested_at: new Date(), handle: 'news' }], calls));
  assert.equal((await dir.waiting(new Date()))[0].title, '@news · tone');
  assert.equal((await contested.waiting(new Date()))[0].refId, 'd1:contested');
  await dir.act('d1', 'decline');
  await contested.act('d1:contested', 'uphold');
  assert.deepEqual(calls, ['decide("d1",false)', 'ownerDecision("d1","uphold")']);
});

test('action source: a kind that needs choices on the card gets only Відкрити', async () => {
  const s = actionSource(deps([
    { id: 'a1', kind: 'content_examples', summary: 'pick', created_at: new Date(), handle: 'news' },
    { id: 'a2', kind: 'set_network_mode', summary: 'go', created_at: new Date(), handle: null },
  ]));
  const items = await s.waiting(new Date());
  assert.deepEqual(items.map((i) => i.buttons.map((b) => b.key)), [['open'], ['apply', 'discard', 'open']]);
});

test('setup source: apply all asks to confirm and reports applied and drifted sections', async () => {
  const calls: string[] = [];
  const s = setupSource(deps([{ id: 'p1', channel_key: '@a', updated_at: new Date() }], calls));
  const [it] = await s.waiting(new Date());
  assert.equal(it.buttons[0].confirm, 'Так, застосувати все');
  const out = await s.act('p1', 'apply_all');
  assert.match(out, /Застосовано: розклад; змінено після аналізу: форматування/);
  assert.deepEqual(calls, ['setupApply(p1,{"sections":["formatting","schedule"]})']);
});
