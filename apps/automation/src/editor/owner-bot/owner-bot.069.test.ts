/**
 * Spec 069 FR-004 / A9 on fakes: a note that answers an older note of the same problem edits that note's card in place
 * (the same Telegram message, the same `oc:<card>:<button>` callbacks); a critical note, a card a day old, a card that was
 * never sent, or a message Telegram no longer has fall back to a new message. Nothing reaches Telegram.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BotApiError, type BotApi, type Keyboard } from './bot-api';
import type { CardSource, WaitingItem } from './card-sources';
import type { CardButton, NewCard, OwnerCard } from './owner-cards.repository';
import { EDIT_IN_PLACE_MS, OwnerBotService, SINCE_KEY } from './owner-bot.service';

const HOUR = 3_600_000;

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
  async queued(limit: number) { return this.cards.filter((c) => c.status === 'queued').slice(0, limit).map((c) => ({ ...c })); }
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
  async markAttempt() { /* not used */ }
  async resolve(id: number, status: 'done' | 'closed', outcome: string, by: string | null) {
    const c = this.cards.find((x) => x.id === id && (x.status === 'queued' || x.status === 'open'));
    if (!c) return null;
    Object.assign(c, { status, outcome, resolvedBy: by, resolvedAt: this.clock() });
    return { ...c };
  }
  /** The real one is one guarded UPDATE: the card must be open and no other card may already hold the new ref. */
  async retarget(id: number, newRefId: string, c: { title: string; body: string | null; buttons: CardButton[]; link: string | null }) {
    const card = this.cards.find((x) => x.id === id && x.status === 'open');
    if (!card || this.cards.some((x) => x.kind === card.kind && x.refId === newRefId)) return null;
    Object.assign(card, { refId: newRefId, title: c.title, body: c.body, buttons: c.buttons, link: c.link });
    return { ...card };
  }
  async sentSince(since: Date) { return this.cards.filter((c) => c.sentAt && c.sentAt >= since).length; }
  async lastReports() { return { daily: null, weekly: null }; }
  async counts() { return { open: 0, queued: 0, sentToday: 0, failed: 0 }; }
}

class FakeApi implements BotApi {
  sent: Array<{ chatId: string; text: string; kb: Keyboard | null | undefined; id: number }> = [];
  edits: Array<{ chatId: string; messageId: number; text: string; kb: Keyboard | null | undefined }> = [];
  answers: Array<{ id: string; text?: string }> = [];
  editError: Error | null = null;
  private msg = 100;
  async send(chatId: string, text: string, kb?: Keyboard | null) { const id = ++this.msg; this.sent.push({ chatId, text, kb, id }); return id; }
  async edit(chatId: string, messageId: number, text: string, kb?: Keyboard | null) {
    if (this.editError) throw this.editError;
    this.edits.push({ chatId, messageId, text, kb });
  }
  async answer(id: string, text?: string) { this.answers.push({ id, text }); }
}

function settingsPool() {
  const rows = new Map<string, string>([[SINCE_KEY, '2026-10-19T00:00:00Z']]);
  return {
    async query(sql: string, params: any[] = []) {
      if (/^SELECT value FROM app_settings/.test(sql)) return { rows: rows.has(params[0]) ? [{ value: rows.get(params[0]) }] : [] };
      if (/^INSERT INTO app_settings/.test(sql)) { rows.set(params[0], params[1]); return { rows: [] }; }
      throw new Error(`unexpected query: ${sql}`);
    },
  } as any;
}

/** An `inbox` source whose items are the unread notes; `act` records the button the owner pressed. */
function inboxSource() {
  const src = {
    kind: 'inbox', emoji: '📬', label: 'Повідомлення', items: [] as WaitingItem[], acts: [] as Array<[string, string]>,
    async waiting() { return src.items; },
    async act(ref: string, key: string) { src.acts.push([ref, key]); return '✓ Прочитано'; },
  };
  return src;
}

function setup(o: { now?: string } = {}) {
  let now = new Date(o.now ?? '2026-10-22T09:00:00Z');
  const clock = () => now;
  const repo = new MemRepo(clock);
  const api = new FakeApi();
  const src = inboxSource();
  const env: Record<string, string> = { TELEGRAM_OWNER_ID: '42', DASHBOARD_URL: 'https://dash.example/' };
  const logs: string[] = [];
  const bot = new OwnerBotService({ pool: settingsPool(), repo: repo as any, api, sources: [src as CardSource], env: (k) => env[k], now: clock, log: (m) => logs.push(m) });
  const waiting = (...ids: number[]) => { src.items = ids.map((id) => ({ refId: String(id), title: `note ${id}`, body: null, path: '/app/agents/inbox', critical: false, since: new Date(clock().getTime() - 60_000), buttons: [] })); };
  return { bot, repo, api, src, logs, waiting, setNow: (iso: string) => { now = new Date(iso); }, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

const action = (title: string, over: Record<string, unknown> = {}) => ({ kind: 'series_missed', severity: 'action' as const, title: `EN ${title}`, body: 'b', alert: { title, body: 'тіло' }, ...over });
const cb = (data: string) => ({ id: `cb-${data}`, fromId: 42, chatId: 42, chatType: 'private', messageId: 101, data });

/** The first note's card is made and sent; returns the card. */
async function sentCard(t: ReturnType<typeof setup>, id = 1, title = 'Серія не вийшла') {
  assert.equal(await t.bot.inboxNote(id, action(title)), true);
  t.waiting(id);
  await t.bot.sweep();
  assert.equal(t.api.sent.length, 1, 'the first note went out as a message');
  return t.repo.cards[0];
}

test('a note that answers an older one edits the open card in place: same message, same buttons, a new ref', async () => {
  const t = setup();
  const card = await sentCard(t);
  assert.equal(card.status, 'open');
  assert.equal(card.messageId, 101);

  t.advance(3 * HOUR);
  const res = await t.bot.inboxNote(2, action('Серія досі не виходить'), { replaces: [1] });
  assert.deepEqual(res, { retargeted: 1 });
  assert.equal(t.api.sent.length, 1, 'no second message');
  assert.equal(t.api.edits.length, 1);
  assert.equal(t.api.edits[0].messageId, 101);
  assert.match(t.api.edits[0].text, /Серія досі не виходить/);
  assert.equal(t.repo.cards.length, 1, 'still one card');
  assert.equal(t.repo.cards[0].refId, '2');
  assert.equal(t.repo.cards[0].status, 'open');

  // The old buttons still work, and now act on the new note.
  t.waiting(2);
  await t.bot.callback(cb(`oc:${card.id}:0`));
  assert.deepEqual(t.src.acts, [['2', 'read']]);
  assert.equal(t.repo.cards[0].status, 'done');
});

test('a sweep after the edit does not close the card: the source now lists the new note', async () => {
  const t = setup();
  await sentCard(t);
  await t.bot.inboxNote(2, action('Серія досі не виходить'), { replaces: [1] });
  t.waiting(2);
  const r = await t.bot.sweep();
  assert.equal(r.closed, 0);
  assert.equal(r.created, 0);
  assert.equal(t.repo.cards[0].status, 'open');
});

test('a critical note, a card a day old and a card that was never sent each get a new card, not an edit', async () => {
  // critical: a new message that rings.
  const a = setup();
  await sentCard(a);
  assert.equal(await a.bot.inboxNote(2, action('Зламано', { severity: 'critical' }), { replaces: [1] }), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(a.api.edits.length, 0);
  assert.equal(a.repo.cards.length, 2);
  assert.equal(a.api.sent.length, 2);

  // a day old: the owner has long stopped looking at that message.
  const b = setup();
  await sentCard(b);
  b.advance(EDIT_IN_PLACE_MS + HOUR);
  assert.equal(await b.bot.inboxNote(2, action('Серія досі не виходить'), { replaces: [1] }), true);
  assert.equal(b.api.edits.length, 0);
  assert.equal(b.repo.cards.length, 2);

  // never sent (still queued): there is no message to edit.
  const c = setup();
  assert.equal(await c.bot.inboxNote(1, action('Серія не вийшла')), true);
  assert.equal(await c.bot.inboxNote(2, action('Серія досі не виходить'), { replaces: [1] }), true);
  assert.equal(c.api.edits.length, 0);
  assert.equal(c.repo.cards.length, 2);

  // no `replaces` at all (the first note of a problem): a plain new card.
  const d = setup();
  assert.equal(await d.bot.inboxNote(1, action('Серія не вийшла')), true);
  assert.equal(d.repo.cards.length, 1);
});

test('the edit may be a no-op for Telegram ("not modified"): the card is still moved and nothing else happens', async () => {
  const t = setup();
  await sentCard(t);
  t.api.editError = new BotApiError('Bad Request: message is not modified', 400);
  assert.deepEqual(await t.bot.inboxNote(2, action('Серія не вийшла'), { replaces: [1] }), { retargeted: 1 });
  assert.equal(t.api.sent.length, 1);
  assert.equal(t.repo.cards[0].refId, '2');
  assert.equal(t.repo.cards[0].status, 'open');
});

test('the message is gone: the card is queued again and goes out as a new message with the new note', async () => {
  const t = setup();
  await sentCard(t);
  t.api.editError = new BotApiError('Bad Request: message to edit not found', 400);
  assert.deepEqual(await t.bot.inboxNote(2, action('Серія досі не виходить'), { replaces: [1] }), { retargeted: 1 });
  assert.equal(t.api.sent.length, 2, 'sent again');
  assert.match(t.api.sent[1].text, /Серія досі не виходить/);
  assert.equal(t.repo.cards.length, 1);
  assert.equal(t.repo.cards[0].refId, '2');
  assert.equal(t.repo.cards[0].status, 'open');
  assert.equal(t.repo.cards[0].messageId, 102);
});

test('another failure of the edit puts the card back on the old note and makes a new card: the old keyboard can never run the new buttons', async () => {
  const t = setup();
  await sentCard(t);
  const oldButtons = t.repo.cards[0].buttons;
  const oldTitle = t.repo.cards[0].title;
  t.api.editError = new Error('socket hang up');
  // No card was reused: the caller (OwnerInbox) closes the old card through supersedeCards and the new note gets a card of its own.
  assert.equal(await t.bot.inboxNote(2, action('Серія досі не виходить'), { replaces: [1] }), true);
  assert.match(t.logs.join('\n'), /not edited in place/);
  assert.equal(t.repo.cards.length, 2);
  const [old, fresh] = t.repo.cards;
  assert.equal(old.refId, '1', 'the old card is on its old note again');
  assert.equal(old.title, oldTitle);
  assert.deepEqual(old.buttons, oldButtons, 'the stored buttons are the ones the message still shows');
  assert.equal(fresh.refId, '2');
  assert.equal(fresh.status, 'queued');
  assert.match(fresh.title, /Серія досі не виходить/);
  // OwnerInbox then closes the superseded card: the keyboard goes and a late tap meets a closed card.
  t.api.editError = null;
  assert.equal(await t.bot.supersedeCards([1]), 1);
  assert.equal(old.status, 'closed');
});

test('a failed edit with a different button layout never leaves the new buttons behind the old keyboard', async () => {
  const t = setup();
  await sentCard(t);
  t.api.editError = new Error('429 Too Many Requests');
  const two = action('Серія досі не виходить', { actions: [{ key: 'pause:A', label: 'Пауза: A' }, { key: 'pause:B', label: 'Пауза: B' }] });
  await t.bot.inboxNote(2, two, { replaces: [1] });
  const old = t.repo.cards.find((c) => c.refId === '1')!;
  assert.deepEqual(old.buttons.map((b: CardButton) => b.key), ['read', 'open'], 'the old card keeps only the buttons its message shows');
  const fresh = t.repo.cards.find((c) => c.refId === '2')!;
  assert.deepEqual(fresh.buttons.map((b: CardButton) => b.key), ['pause:A', 'pause:B', 'read', 'open']);
});

test('when the new ref already has a card, nothing is retargeted and the caller falls back to the normal path', async () => {
  const t = setup();
  await sentCard(t);
  // A second card for note 2 exists already (a previous attempt): the guarded UPDATE refuses and a plain insert is a no-op.
  await t.repo.insert({ kind: 'inbox', refId: '2', critical: false, title: 'x', body: null, buttons: [], link: null });
  assert.equal(await t.bot.inboxNote(2, action('Серія досі не виходить'), { replaces: [1] }), true);
  assert.equal(t.api.edits.length, 0);
});

test('an info note never retargets a card', async () => {
  const t = setup();
  await sentCard(t);
  assert.equal(await t.bot.inboxNote(2, action('x', { severity: 'info' }), { replaces: [1] }), true);
  assert.equal(t.api.edits.length, 0);
  assert.equal(t.repo.cards[0].refId, '1');
});
