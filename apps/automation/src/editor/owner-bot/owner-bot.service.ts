import type { Pool } from 'pg';
import type { InboxCardOptions, InboxCardRetargeted, InboxItemInput } from '../agents/owner-inbox';
import { pollState, type OwnerCallback, type OwnerCommand, type OwnerBotHandler } from '../../publishers/owner-bot-bus';
import { BotApiError, type BotApi, type Keyboard } from './bot-api';
import { OWN_CARD_REF_TYPES, inboxItem, type CardSource, type WaitingItem } from './card-sources';
import type { CardButton, NewCard, OwnerCard, OwnerCardsRepository } from './owner-cards.repository';
import { cardText, errorText, esc, plural } from './owner-text';

/**
 * Spec 012 part A: the owner bot. Cards for what waits (FR-002), their delivery (FR-003: the minute sweep, critical
 * first, quiet hours, the hourly limit, the backlog rule, closing what was decided elsewhere), the buttons and the
 * commands (FR-004). Telegram arrives through the admin bot's poll (owner-bot-bus); the owner check is done there.
 */

export const SINCE_KEY = 'owner_bot.cards_since';
const HOUR = 3_600_000;
export const WAITING_BATCH = 10;
/** Spec 069 FR-004: a card older than this is not edited in place; the new note gets a new message. */
export const EDIT_IN_PLACE_MS = 24 * HOUR;

export interface OwnerBotDeps {
  pool:    Pick<Pool, 'query'>;
  repo:    OwnerCardsRepository;
  /** Null when there is no bot token: nothing is sent. */
  api:     BotApi | null;
  sources: CardSource[];
  /** Live settings (process.env after the settings overlay). */
  env:     (key: string) => string | undefined;
  /** Extra /status lines (spend, posts, health), from T2. */
  status?: () => Promise<string[]>;
  /** The /today and /week reports (T2, T3): the text and its buttons. */
  reports?: Partial<Record<'today' | 'week', () => Promise<{ text: string; keyboard?: Keyboard | null }>>>;
  log?:    (m: string) => void;
  now?:    () => Date;
}

// ── settings ────────────────────────────────────────────────────────────────

export function cardsOn(env: OwnerBotDeps['env']): boolean {
  return (env('OWNER_BOT_CARDS') ?? 'on').trim() !== 'off';
}

/** "23-8" → [23, 8]; "off" / garbage / equal ends → null (no quiet hours). */
export function parseQuiet(v: string | undefined): [number, number] | null {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(v ?? '23-8');
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  return a < 24 && b < 24 && a !== b ? [a, b] : null;
}

export function kyivHour(d: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hourCycle: 'h23' }).format(d));
}

export function isQuiet(now: Date, q: [number, number] | null): boolean {
  if (!q) return false;
  const h = kyivHour(now);
  const [a, b] = q;
  return a < b ? h >= a && h < b : h >= a || h < b;
}

export function maxPerHour(env: OwnerBotDeps['env']): number {
  const n = Number(env('OWNER_BOT_MAX_PER_HOUR') ?? 30);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 30;
}

/** Callback data: `oc:<card>:<button>` (+ `:y` confirmed, `:n` cancelled). */
export function parseCallback(data: string): { cardId: number; idx: number; confirm: 'y' | 'n' | null } | null {
  const m = /^oc:(\d{1,18}):(\d{1,2})(?::([yn]))?$/.exec(data);
  return m ? { cardId: Number(m[1]), idx: Number(m[2]), confirm: (m[3] as 'y' | 'n' | undefined) ?? null } : null;
}

export function cardKeyboard(card: Pick<OwnerCard, 'id' | 'buttons'>): Keyboard {
  const acts = card.buttons.map((b, i) => ({ b, i })).filter(({ b }) => !b.url).map(({ b, i }) => ({ text: b.label, data: `oc:${card.id}:${i}` }));
  const urls = card.buttons.filter((b) => b.url).map((b) => ({ text: b.label, url: b.url! }));
  return [acts, urls].filter((row) => row.length);
}

export class OwnerBotService implements OwnerBotHandler {
  private readonly byKind: Map<string, CardSource>;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly acting = new Set<number>();
  /** Non-critical cards were held back by quiet hours: the first send after them starts with one line. */
  private heldInQuiet = false;

  constructor(private readonly d: OwnerBotDeps) {
    this.byKind = new Map(d.sources.map((s) => [s.kind, s]));
    this.byKind.set(TEST_SOURCE.kind, TEST_SOURCE);
  }

  private now(): Date { return this.d.now?.() ?? new Date(); }
  private log(m: string) { this.d.log?.(m); }
  private chat(): string | null { return this.d.env('TELEGRAM_OWNER_ID')?.trim() || null; }
  /** Cards are on and can be sent. */
  active(): boolean { return !!this.d.api && !!this.chat() && cardsOn(this.d.env); }

  /** One sender at a time: a sweep, /waiting and a critical note never send the same queued card twice. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private link(path: string | null): string | null {
    const base = this.d.env('DASHBOARD_URL')?.trim();
    return base && path ? `${base.replace(/\/$/, '')}${path}` : null;
  }

  private newCard(kind: string, it: WaitingItem) {
    const link = this.link(it.path);
    const buttons: CardButton[] = it.buttons.flatMap((b) => (b.key === 'open' ? (link ? [{ ...b, url: link }] : []) : [b]));
    return { kind, refId: it.refId, critical: it.critical, title: it.title, body: it.body, buttons, link };
  }

  // ── the sweep (FR-003) ────────────────────────────────────────────────────

  /** The moment cards were switched on; items that waited before it are the backlog (`/waiting` only). */
  async cardsSince(now: Date): Promise<Date> {
    const { rows } = await this.d.pool.query(`SELECT value FROM app_settings WHERE key = $1`, [SINCE_KEY]);
    const at = rows[0] ? new Date(rows[0].value) : null;
    if (at && !Number.isNaN(at.getTime())) return at;
    await this.d.pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [SINCE_KEY, now.toISOString()]);
    return now;
  }

  async sweep(): Promise<{ created: number; closed: number; sent: number }> {
    const out = { created: 0, closed: 0, sent: 0 };
    if (!this.d.api || !this.chat()) return out;
    if (!cardsOn(this.d.env)) {
      // Switched off: the next switch-on starts a new backlog line.
      await this.d.pool.query(`DELETE FROM app_settings WHERE key = $1`, [SINCE_KEY]);
      return out;
    }
    return this.serial(async () => {
      const now = this.now();
      const since = await this.cardsSince(now);
      const live = await this.d.repo.live();
      for (const src of this.d.sources) {
        let items: WaitingItem[];
        try {
          items = await src.waiting(now);
        } catch (err: any) {
          this.log(`owner bot: ${src.kind} source failed: ${err.message}`);
          continue;
        }
        const mine = live.filter((c) => c.kind === src.kind);
        const liveByRef = new Map(mine.map((c) => [c.refId, c]));
        for (const it of items) {
          const card = liveByRef.get(it.refId);
          if (card) {
            if (it.critical && !card.critical && card.status === 'queued') await this.d.repo.markCritical(card.id);
            continue;
          }
          if (it.since.getTime() < since.getTime()) continue;
          if (await this.d.repo.insert(this.newCard(src.kind, it))) out.created++;
        }
        const waiting = new Set(items.map((i) => i.refId));
        const stale = mine.filter((c) => !waiting.has(c.refId));
        if (!stale.length) continue;
        const expired = (await src.expired?.(stale.map((c) => c.refId)).catch(() => null)) ?? new Set<string>();
        for (const c of stale) {
          if (await this.close(c, expired.has(c.refId) ? 'Минув термін' : 'Вирішено в дашборді')) out.closed++;
        }
      }
      out.sent = await this.deliver(now);
      return out;
    });
  }

  /** Sends what may go now: critical cards always, the rest outside quiet hours and within the hourly limit. */
  private async deliver(now: Date): Promise<number> {
    const quiet = isQuiet(now, parseQuiet(this.d.env('OWNER_QUIET_HOURS')));
    let room = maxPerHour(this.d.env) - (await this.d.repo.sentSince(new Date(now.getTime() - HOUR)));
    const queued = await this.d.repo.queued(500);
    const go: OwnerCard[] = [];
    let held = 0;
    for (const c of queued) {
      if (c.critical) go.push(c);
      else if (!quiet && room > 0) { go.push(c); room--; }
      else held++;
    }
    if (quiet && held) this.heldInQuiet = true;
    if (!quiet && this.heldInQuiet) {
      this.heldInQuiet = false;
      const n = queued.filter((c) => !c.critical).length;
      if (n) await this.say(this.chat()!, `🌙 Поки ви відпочивали: ${n} ${plural(n, 'картка', 'картки', 'карток')}`);
    }
    let sent = 0;
    for (const c of go) if (await this.send(c)) sent++;
    return sent;
  }

  private async send(card: OwnerCard): Promise<boolean> {
    const chat = this.chat();
    if (!this.d.api || !chat) return false;
    const src = this.byKind.get(card.kind);
    try {
      const id = await this.d.api.send(chat, this.text(card, src), cardKeyboard(card));
      await this.d.repo.markSent(card.id, chat, id);
      return true;
    } catch (err: any) {
      await this.d.repo.markAttempt(card.id, errorText(err));
      this.log(`owner bot: card ${card.id} not sent: ${errorText(err)}`);
      return false;
    }
  }

  private text(card: Pick<OwnerCard, 'kind' | 'title' | 'body'>, src = this.byKind.get(card.kind), outcome?: string | null): string {
    return cardText({ emoji: src?.emoji ?? '•', label: src?.label ?? card.kind, title: card.title, body: card.body, outcome });
  }

  /** Closes a card decided elsewhere: the buttons go and it says why. False when it was no longer live. */
  private async close(card: OwnerCard, outcome: string): Promise<boolean> {
    const done = await this.d.repo.resolve(card.id, 'closed', outcome, null);
    if (!done) return false;
    if (done.chatId && done.messageId) await this.edit(done.chatId, done.messageId, this.text(done, undefined, outcome), null);
    return true;
  }

  private async edit(chatId: string, messageId: number, text: string, kb: Keyboard | null): Promise<void> {
    try {
      await this.d.api?.edit(chatId, messageId, text, kb);
    } catch (err: any) {
      // A card the owner deleted, or one Telegram no longer edits, is left as it is (FR-003).
      if (err instanceof BotApiError && (err.gone || err.notModified)) return;
      this.log(`owner bot: edit failed: ${errorText(err)}`);
    }
  }

  /** A message to the owner chat (the reports); false when it did not go out. */
  async sendToOwner(text: string, kb?: Keyboard | null): Promise<boolean> {
    const chat = this.chat();
    if (!this.d.api || !chat) return false;
    try {
      await this.d.api.send(chat, text, kb ?? null);
      return true;
    } catch (err: any) {
      this.log(`owner bot: message not sent: ${errorText(err)}`);
      return false;
    }
  }

  private async say(chatId: string, text: string, kb?: Keyboard | null): Promise<void> {
    try {
      await this.d.api?.send(chatId, text, kb ?? null);
    } catch (err: any) {
      this.log(`owner bot: message not sent: ${errorText(err)}`);
    }
  }

  // ── inbox notes (FR-002 "Inbox alerts") ───────────────────────────────────

  /**
   * OwnerInbox's card sink: while cards are on, a critical or action note becomes a card (in its Telegram wording), an
   * info note waits for the daily summary and a note about a directive or a playbook is covered by that item's card.
   * A critical card goes out at once.
   */
  async inboxNote(id: number, i: InboxItemInput, o: InboxCardOptions = {}): Promise<boolean | InboxCardRetargeted> {
    if (!this.active()) return false;
    const severity = i.severity ?? 'info';
    if (severity === 'info') return true;
    if (i.refType && OWN_CARD_REF_TYPES.includes(i.refType)) return true;
    const words = i.alert ?? { title: i.title, body: i.body ?? null };
    const item = this.newCard('inbox', inboxItem(id, { title: words.title, body: words.body ?? null, severity, actions: i.actions }, this.now()));
    // Spec 069 FR-004: a note that answers an older one of the same problem edits that card's message in place — unless it is
    // critical (a new message that rings) or the old card is a day old.
    if (severity !== 'critical' && o.replaces?.length) {
      const edited = await this.retarget(o.replaces, item);
      if (edited != null) return { retargeted: edited };
    }
    const card = await this.d.repo.insert(item);
    if (card?.critical) void this.serial(() => this.send(card)).catch(() => undefined);
    return true;
  }

  /**
   * Points the open, sent, under-a-day-old card of one of the replaced notes at the new one and edits its message (the
   * `oc:<card>:<button>` callbacks stay valid). Returns the replaced note's id, or null when no card could be reused (a
   * new card is made instead). The message gone: the card goes back to the queue and is sent again as a new message.
   */
  private async retarget(replaces: number[], item: NewCard): Promise<number | null> {
    return this.serial(async () => {
      const at = (c: OwnerCard) => (c.sentAt ?? c.createdAt).getTime();
      const card = (await this.d.repo.byRefs('inbox', replaces.map(String)))
        .filter((c) => c.status === 'open' && c.messageId != null && !!c.chatId && this.now().getTime() - at(c) < EDIT_IN_PLACE_MS)
        .sort((a, b) => at(b) - at(a))[0];
      if (!card) return null;
      const replaced = Number(card.refId);
      const moved = await this.d.repo.retarget(card.id, item.refId, { title: item.title, body: item.body ?? null, buttons: item.buttons, link: item.link ?? null });
      if (!moved) return null;
      try {
        await this.d.api!.edit(moved.chatId!, moved.messageId!, this.text(moved), cardKeyboard(moved));
      } catch (err: any) {
        if (err instanceof BotApiError && err.notModified) return replaced;
        if (err instanceof BotApiError && err.gone) {
          await this.d.repo.resolve(moved.id, 'closed', 'Повідомлення видалено', null);
          if (await this.d.repo.requeue(moved.id)) await this.deliver(this.now());
          return replaced;
        }
        // Any other failure (a 429, a timeout, a 5xx): the message still shows the OLD keyboard, and a tap is resolved by
        // button position against the card's stored buttons — so the card must not keep the new note's buttons. Put it
        // back on the old note and report "no card reused": the caller makes a new card for the new note and the
        // supersede step closes this one (stripping the keyboard), so a stale tap cannot run a different action.
        this.log(`owner bot: card ${moved.id} not edited in place: ${errorText(err)}`);
        try {
          const back = await this.d.repo.retarget(moved.id, card.refId, { title: card.title, body: card.body ?? null, buttons: card.buttons, link: card.link ?? null });
          if (!back) this.log(`owner bot: card ${moved.id} could not be put back on note ${replaced}`);
        } catch (e) {
          this.log(`owner bot: card ${moved.id} could not be put back on note ${replaced}: ${errorText(e)}`);
        }
        return null;
      }
      return replaced;
    });
  }

  /**
   * Spec 060 FR-003: a newer note of the same subject answered these notes. Their live cards close ("replaced by a
   * newer one"), so the owner sees one live card per problem.
   */
  async supersedeCards(inboxIds: number[]): Promise<number> {
    if (!this.d.api || !inboxIds.length) return 0;
    const cards = (await this.d.repo.byRefs('inbox', inboxIds.map(String))).filter((c) => c.status === 'queued' || c.status === 'open');
    if (!cards.length) return 0;
    return this.serial(async () => {
      let n = 0;
      for (const c of cards) if (await this.close(c, 'Замінено новішою карткою')) n++;
      return n;
    });
  }

  // ── buttons ───────────────────────────────────────────────────────────────

  async callback(cb: OwnerCallback): Promise<void> {
    const api = this.d.api;
    if (!api) return;
    if (cb.data === 'oc:waiting') {
      // The reports' "Що чекає" button: the same as /waiting.
      await api.answer(cb.id);
      const chat = cb.chatId != null ? String(cb.chatId) : this.chat();
      if (chat) await this.say(chat, await this.waitingNow());
      return;
    }
    const p = parseCallback(cb.data);
    const card = p ? await this.d.repo.get(p.cardId) : null;
    if (!p || !card) { await api.answer(cb.id, 'Картку не знайдено'); return; }
    const chatId = cb.chatId != null ? String(cb.chatId) : card.chatId;
    const msgId = cb.messageId ?? card.messageId;
    if (card.status !== 'open' && card.status !== 'queued') {
      await api.answer(cb.id, 'Вже вирішено');
      if (chatId && msgId) await this.edit(chatId, msgId, this.text(card, undefined, card.outcome ?? 'Вже вирішено'), null);
      return;
    }
    const btn = card.buttons[p.idx];
    if (!btn || btn.url) { await api.answer(cb.id); return; }

    if (btn.confirm && p.confirm === null) {
      if (chatId && msgId) {
        await this.edit(chatId, msgId, this.text(card), [[
          { text: btn.confirm, data: `oc:${card.id}:${p.idx}:y` }, { text: 'Скасувати', data: `oc:${card.id}:${p.idx}:n` },
        ]]);
      }
      await api.answer(cb.id);
      return;
    }
    if (p.confirm === 'n') {
      if (chatId && msgId) await this.edit(chatId, msgId, this.text(card), cardKeyboard(card));
      await api.answer(cb.id, 'Скасовано');
      return;
    }

    const src = this.byKind.get(card.kind);
    if (!src) { await api.answer(cb.id, 'Невідома картка'); return; }
    if (this.acting.has(card.id)) { await api.answer(cb.id, 'Виконується…'); return; }
    this.acting.add(card.id);
    let outcome: string;
    try {
      outcome = await src.act(card.refId, btn.key);
    } catch (err: any) {
      const reason = errorText(err);
      await api.answer(cb.id, `❌ ${reason}`);
      if (chatId && msgId) await this.edit(chatId, msgId, this.text(card, src, `❌ Не вдалося: ${reason}`), cardKeyboard(card));
      return;
    } finally {
      this.acting.delete(card.id);
    }
    const done = await this.d.repo.resolve(card.id, 'done', outcome, `telegram:${cb.fromId}`);
    if (chatId && msgId) await this.edit(chatId, msgId, this.text(done ?? card, src, outcome), null);
    await api.answer(cb.id, outcome);
  }

  // ── commands (FR-004) ─────────────────────────────────────────────────────

  help(): string[] {
    return [
      '/status — що чекає на вас',
      '/waiting — надіслати картки того, що чекає',
      ...(this.d.reports?.today ? ['/today — підсумок дня'] : []),
      ...(this.d.reports?.week ? ['/week — звіт за тиждень'] : []),
    ];
  }

  async command(cmd: OwnerCommand): Promise<boolean> {
    const chat = String(cmd.chatId);
    const name = cmd.text.split(/\s+/)[0];
    switch (name) {
      case '/status':  await this.say(chat, await this.statusText()); return true;
      case '/waiting': await this.say(chat, await this.waitingNow()); return true;
      case '/today':
      case '/week': {
        const r = this.d.reports?.[name === '/today' ? 'today' : 'week'];
        if (!r) return false;
        try {
          const rep = await r();
          await this.say(chat, rep.text, rep.keyboard ?? null);
        } catch (err: any) {
          await this.say(chat, `❌ ${esc(errorText(err))}`);
        }
        return true;
      }
    }
    return false;
  }

  /** What waits, by kind, every item (the backlog included). */
  async waitingCounts(): Promise<Array<{ kind: string; label: string; emoji: string; n: number }>> {
    const now = this.now();
    const out: Array<{ kind: string; label: string; emoji: string; n: number }> = [];
    for (const s of this.d.sources) {
      const n = (await s.waiting(now).catch(() => [])).length;
      if (n) out.push({ kind: s.kind, label: s.label, emoji: s.emoji, n });
    }
    return out;
  }

  async statusText(): Promise<string> {
    const counts = await this.waitingCounts();
    const cards = await this.d.repo.counts(new Date(this.now().getTime() - 24 * HOUR));
    const lines = ['<b>Що чекає на вас</b>'];
    if (counts.length) for (const c of counts) lines.push(`${c.emoji} ${esc(c.label)}: ${c.n}`);
    else lines.push('Нічого не чекає ✓');
    lines.push('', `Картки: відкрито ${cards.open}, у черзі ${cards.queued}${cards.failed ? `, не надіслано ${cards.failed}` : ''}`);
    if (!cardsOn(this.d.env)) lines.push('Картки вимкнено (OWNER_BOT_CARDS = off)');
    const extra = await this.d.status?.().catch(() => []) ?? [];
    if (extra.length) lines.push('', ...extra);
    return lines.join('\n');
  }

  /** /waiting: up to 10 waiting items without an open card, oldest first, sent now (quiet hours and the backlog rule aside). */
  async waitingNow(): Promise<string> {
    if (!this.d.api || !this.chat()) return 'Бот не налаштовано';
    return this.serial(async () => {
      const now = this.now();
      const todo: Array<{ src: CardSource; it: WaitingItem; card: OwnerCard | null }> = [];
      for (const src of this.d.sources) {
        const items = await src.waiting(now).catch(() => [] as WaitingItem[]);
        const cards = new Map((await this.d.repo.byRefs(src.kind, items.map((i) => i.refId))).map((c) => [c.refId, c]));
        for (const it of items) {
          const card = cards.get(it.refId) ?? null;
          if (card?.status === 'open' || card?.status === 'done') continue;
          todo.push({ src, it, card });
        }
      }
      todo.sort((a, b) => a.it.since.getTime() - b.it.since.getTime());
      let sent = 0;
      for (const t of todo.slice(0, WAITING_BATCH)) {
        let card = t.card;
        if (card && card.status !== 'queued') card = await this.d.repo.requeue(card.id);
        if (!card) card = await this.d.repo.insert(this.newCard(t.src.kind, t.it));
        if (card && (await this.send(card))) sent++;
      }
      const left = Math.max(0, todo.length - WAITING_BATCH);
      if (!todo.length) return 'Нічого не чекає ✓';
      return left ? `Надіслано ${sent}. Ще чекає: ${left} — /waiting ще раз.` : `Надіслано ${sent}. Це все.`;
    });
  }

  /** FR-007: the Owner bot section of /app/health. `dayStart` = the start of today (Kyiv) for "sent today". */
  async state(dayStart: Date) {
    const [cards, waiting, reports] = await Promise.all([
      this.d.repo.counts(dayStart), this.waitingCounts(), this.d.repo.lastReports(),
    ]);
    const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
    return {
      configured: { token: !!this.d.api, owner: !!this.chat() },
      cardsOn: cardsOn(this.d.env),
      polling: { running: pollState.running, lastPollAt: iso(pollState.lastPollAt), lastUpdateAt: iso(pollState.lastUpdateAt), lastError: pollState.lastError },
      cards: { open: cards.open, queued: cards.queued, sentToday: cards.sentToday, failedToday: cards.failed },
      waiting: waiting.map((w) => ({ kind: w.kind, count: w.n })),
      settings: {
        quietHours: this.d.env('OWNER_QUIET_HOURS') ?? '23-8', maxPerHour: maxPerHour(this.d.env),
        dailyAt: this.d.env('OWNER_DAILY_REPORT_AT') ?? '21:00', weeklyAt: this.d.env('OWNER_WEEKLY_REPORT_AT') ?? 'Mon 09:00',
      },
      reports: { dailyAt: iso(reports.daily), weeklyAt: iso(reports.weekly) },
    };
  }

  /** FR-007: a card with one "Працює" button that closes it. */
  async testCard(): Promise<{ sent: boolean; error?: string }> {
    if (!this.d.api || !this.chat()) return { sent: false, error: 'TELEGRAM_BOT_TOKEN or TELEGRAM_OWNER_ID is not set' };
    const card = await this.d.repo.insert({
      kind: TEST_SOURCE.kind, refId: `test:${this.now().toISOString()}`, critical: true, title: 'Перевірка бота',
      body: 'Натисніть кнопку: картка закриється.', buttons: [{ key: 'ok', label: 'Працює' }],
    });
    if (!card) return { sent: false, error: 'not created' };
    const ok = await this.serial(() => this.send(card));
    if (ok) return { sent: true };
    return { sent: false, error: (await this.d.repo.get(card.id))?.lastError ?? 'not sent' };
  }
}

const TEST_SOURCE: CardSource = {
  kind: 'test', emoji: '🧪', label: 'Тест',
  async waiting() { return []; },
  async act() { return '✅ Працює'; },
};
