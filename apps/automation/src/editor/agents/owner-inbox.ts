import type { Pool } from 'pg';
import { DEMOTE_AFTER, decideNote, noteGrowStep, noteRepeatDays, partsKey, stillWording, type NoteGate } from './note-gate';
import { actionViews, type InboxActionView, type NoteAction } from '../series-pause/note-actions';

export type InboxSeverity = 'info' | 'action' | 'critical';

export interface InboxItemInput {
  agentId?:  string | null;
  kind:      string;
  title:     string;
  body?:     string | null;
  refType?:  string | null;
  refId?:    string | null;
  severity?: InboxSeverity;
  /**
   * The Telegram alert's own wording when it differs from the stored item:
   * dashboard copy is English (AI0-79) while the owner's Telegram alerts stay
   * as they were until the owner decides. Without it the alert repeats title/body.
   */
  alert?:    { title: string; body?: string | null } | null;
  /**
   * Spec 060 FR-003: the problem this note is about and what it says. A gated note (`postOnce`) fires again only when it
   * says something new or once per OWNER_NOTE_REPEAT_DAYS as "still"; a newer note of the same subject supersedes the
   * older unread ones (and closes their owner-bot cards).
   */
  gate?:     NoteGate | null;
  /**
   * Spec 060 FR-004: buttons the owner-bot card gets before Read / Open (Відновити, Пауза серії, Заглушити на 7 днів, …).
   * Stored with the note (`agent_inbox.actions`) so a card the sweep makes later has them too.
   */
  actions?:  NoteAction[] | null;
}

/**
 * Spec 037 FR-010 (T10): the silent-day alerts, at most one note per resource per (local) day and kind
 * (`postOnce` with `dailyRef`; a unique partial index of migration 076 backs the dedup).
 */
export const SILENT_DAY_KINDS = ['dark_day', 'series_missed', 'critic_reject_streak'] as const;
export type SilentDayKind = typeof SILENT_DAY_KINDS[number];
export const RESOURCE_DAY_REF = 'resource_day';

/** The dedup key of a once-per-resource-per-day note: ref_type `resource_day`, ref_id `<resource_ref>|<YYYY-MM-DD>`. */
export function dailyRef(resourceRef: string, day: string): { refType: string; refId: string } {
  return { refType: RESOURCE_DAY_REF, refId: `${resourceRef}|${day}` };
}

export interface InboxItem extends Required<Omit<InboxItemInput, 'agentId' | 'alert' | 'gate' | 'actions'>> {
  id:        number;
  agentId:   string | null;
  readAt:    Date | null;
  createdAt: Date;
  /** Spec 078 D5 gap #1: the problem the note is about and what it said (spec 060 gate); null for a note without a gate. */
  subject:   string | null;
  parts:     string[] | null;
  /** The note's buttons in the dashboard's words (English); the stored Ukrainian labels stay on the Telegram card. */
  actions:   InboxActionView[];
}

const toItem = (r: any): InboxItem => ({
  id: Number(r.id), agentId: r.agent_id ?? null, kind: r.kind, title: r.title, body: r.body ?? null,
  refType: r.ref_type ?? null, refId: r.ref_id ?? null, severity: r.severity, readAt: r.read_at ?? null, createdAt: r.created_at,
  subject: r.subject ?? null, parts: r.parts ?? null, actions: actionViews(r.actions),
});

/**
 * Spec 012 FR-002: while the owner bot's cards are on, a stored note goes to the bot instead of the plain alert (a
 * critical or action note becomes a card, an info note waits for the daily summary). The sink returns true when it
 * took the note; false (or a throw) falls back to the alert. Module-level, as every OwnerInbox shares the one bot.
 */
export type InboxCardSink = (id: number, i: InboxItemInput, o?: InboxCardOptions) => Promise<boolean | InboxCardRetargeted>;
/**
 * Spec 069 FR-004 / A9: `replaces` are the unread notes of the same subject this one superseded. The sink may edit the
 * open card of ONE of them in place instead of sending a new message; it then answers `{ retargeted: <that note's id> }`
 * and the inbox closes the cards of the other ids only.
 */
export interface InboxCardOptions { replaces?: number[] }
export interface InboxCardRetargeted { retargeted: number }
let cardSink: InboxCardSink | null = null;
export function setInboxCardSink(sink: InboxCardSink | null): void { cardSink = sink; }

/** Spec 060 FR-003: told which notes a newer note superseded, so the owner bot can close their cards. */
export type InboxSupersedeSink = (ids: number[]) => Promise<void>;
let supersedeSink: InboxSupersedeSink | null = null;
export function setInboxSupersedeSink(sink: InboxSupersedeSink | null): void { supersedeSink = sink; }

/**
 * The owner's inbox for agent events (skill self-edits, rollbacks, cards that
 * need a decision). Every item is stored and also pushed to the admin bot: as a
 * card while the 012 owner bot's cards are on, else as a plain alert.
 */
export class OwnerInbox {
  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly alert: (text: string) => Promise<void> = async () => {},
    private readonly dashboardUrl: string | null = null,
  ) {}

  async post(i: InboxItemInput): Promise<number> {
    const { rows } = i.gate
      ? await this.pool.query(
        `INSERT INTO agent_inbox (agent_id, kind, title, body, ref_type, ref_id, severity, subject, parts) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [i.agentId ?? null, i.kind, i.title.slice(0, 300), i.body ?? null, i.refType ?? null, i.refId ?? null, i.severity ?? 'info', i.gate.subject, i.gate.parts])
      : await this.pool.query(
        `INSERT INTO agent_inbox (agent_id, kind, title, body, ref_type, ref_id, severity) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [i.agentId ?? null, i.kind, i.title.slice(0, 300), i.body ?? null, i.refType ?? null, i.refId ?? null, i.severity ?? 'info']);
    const id = Number(rows[0].id);
    await this.storeActions(id, i);
    await this.deliver(id, i, await this.answered(id, i));
    return id;
  }

  /**
   * Store and alert only when no item of the same kind and ref exists yet (the once-per-resource-per-day notes,
   * spec 037 FR-010). Returns the new id, or null when it was a duplicate (no alert either).
   */
  async postOnce(i0: InboxItemInput & { refType: string; refId: string }): Promise<number | null> {
    let i = i0;
    let demoted = false;
    const gate = i.gate;
    if (gate) {
      // Spec 060 FR-003 / 069 FR-004: a gated note fires again only on a new cause or a number that grew by a whole step
      // (against everything the subject said in the window), or as "still" after OWNER_NOTE_REPEAT_DAYS.
      const now = new Date();
      const repeatDays = noteRepeatDays();
      const d = decideNote(await this.past(gate.subject), gate.parts, now, repeatDays, { step: noteGrowStep(), grow: gate.grow });
      if (!d.fire) return null;
      if (d.why === 'repeat') {
        const w = stillWording(i.title, i.alert?.title, d.stillDays);
        i = { ...i, title: w.title, alert: i.alert && w.alertTitle ? { ...i.alert, title: w.alertTitle } : i.alert };
      }
      // Spec 069 FR-004 / A10: the third note of a run with no reaction from the owner is posted as info (the daily summary
      // lists it); a critical note is never demoted.
      const severity = i.severity ?? 'info';
      if (d.runLength >= DEMOTE_AFTER && (severity === 'action') && !(await this.ownerActed(gate.subject, d.runSince))) {
        i = { ...i, severity: 'info' };
        demoted = true;
      }
      // The same cause and number cannot be stored twice on a day; a changed one can.
      i = { ...i, refId: `${i.refId}#${partsKey(gate.parts)}` };
    }
    let rows: any[];
    try {
      ({ rows } = i.gate
        ? await this.pool.query(
          `INSERT INTO agent_inbox (agent_id, kind, title, body, ref_type, ref_id, severity, subject, parts)
           SELECT $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::text[]
            WHERE NOT EXISTS (SELECT 1 FROM agent_inbox WHERE kind = $2 AND ref_type = $5 AND ref_id = $6)
           RETURNING id`,
          [i.agentId ?? null, i.kind, i.title.slice(0, 300), i.body ?? null, i.refType, i.refId, i.severity ?? 'info', i.gate.subject, i.gate.parts])
        : await this.pool.query(
          `INSERT INTO agent_inbox (agent_id, kind, title, body, ref_type, ref_id, severity)
           SELECT $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text
            WHERE NOT EXISTS (SELECT 1 FROM agent_inbox WHERE kind = $2 AND ref_type = $5 AND ref_id = $6)
           RETURNING id`,
          [i.agentId ?? null, i.kind, i.title.slice(0, 300), i.body ?? null, i.refType, i.refId, i.severity ?? 'info']));
    } catch (err: any) {
      if (err?.code === '23505') return null; // a concurrent insert won the unique index (migration 076)
      throw err;
    }
    if (!rows.length) return null;
    const id = Number(rows[0].id);
    await this.storeActions(id, i);
    await this.deliver(id, i, await this.answered(id, i), demoted);
    return id;
  }

  /** The unread notes of the subject this one answers (marked read now); none for a note without a gate or a standalone one. */
  private async answered(id: number, i: InboxItemInput): Promise<number[]> {
    return i.gate && !i.gate.standalone ? this.supersedeIds(id, i.gate.subject) : [];
  }

  /**
   * Spec 069 A10: whether the owner reacted to the subject's run of notes — a card of one of its notes was resolved from
   * Telegram (`owner_cards.resolved_by LIKE 'telegram:%'`) since the run began. A failed lookup counts as a reaction: a
   * note is never demoted on a guess.
   */
  private async ownerActed(subject: string, since: Date | null): Promise<boolean> {
    try {
      const { rows } = await this.pool.query(
        `SELECT 1 FROM owner_cards c JOIN agent_inbox n ON c.kind = 'inbox' AND c.ref_id = n.id::text
          WHERE n.subject = $1 AND n.created_at >= $2 AND c.resolved_by LIKE 'telegram:%' LIMIT 1`,
        [subject, since ?? new Date(0)]);
      return rows.length > 0;
    } catch {
      return true;
    }
  }

  private async storeActions(id: number, i: InboxItemInput): Promise<void> {
    if (!i.actions?.length) return;
    try { await this.pool.query(`UPDATE agent_inbox SET actions = $2::jsonb WHERE id = $1`, [id, JSON.stringify(i.actions)]); } catch { /* the note stands without its buttons */ }
  }

  /** The subject's notes, newest first (the memory of the repeat rule). */
  private async past(subject: string): Promise<Array<{ parts: string[] | null; createdAt: Date }>> {
    const { rows } = await this.pool.query(
      `SELECT parts, created_at FROM agent_inbox WHERE subject = $1 AND created_at > now() - interval '60 days' ORDER BY created_at DESC, id DESC LIMIT 60`, [subject]);
    return rows.map((r: any) => ({ parts: r.parts ?? null, createdAt: new Date(r.created_at) }));
  }

  /** Spec 060 FR-003: a newer note of the same subject answers the older unread ones (read) and closes their cards. */
  async supersede(newId: number, subject: string): Promise<number[]> {
    const ids = await this.supersedeIds(newId, subject);
    await this.closeCardsOf(ids);
    return ids;
  }

  /** Marks the subject's older unread notes read and returns their ids; their cards are closed by `closeCardsOf`. */
  private async supersedeIds(newId: number, subject: string): Promise<number[]> {
    const { rows } = await this.pool.query(
      `UPDATE agent_inbox SET read_at = now() WHERE subject = $1 AND id <> $2 AND read_at IS NULL RETURNING id`, [subject, newId]);
    return rows.map((r: any) => Number(r.id));
  }

  private async closeCardsOf(ids: number[]): Promise<void> {
    if (ids.length && supersedeSink) {
      try { await supersedeSink(ids); } catch { /* the sweep closes the cards at the latest */ }
    }
  }

  /**
   * Spec 069 A9: the card sink first (it may edit one open card in place), then the cards of the other superseded notes
   * are closed. A demoted note (info) never falls back to the plain alert: the daily summary lists it.
   */
  private async deliver(id: number, i: InboxItemInput, replaces: number[] = [], demoted = false): Promise<void> {
    let retargeted: number | null = null;
    try {
      if (cardSink) {
        try {
          const r = await cardSink(id, i, { replaces });
          if (r) {
            if (typeof r === 'object' && typeof r.retargeted === 'number') retargeted = r.retargeted;
            return;
          }
        } catch { /* the plain alert below */ }
      }
      if (!demoted) await this.sendAlert(i);
    } finally {
      await this.closeCardsOf(replaces.filter((x) => x !== retargeted));
    }
  }

  private async sendAlert(i: InboxItemInput): Promise<void> {
    const link = this.dashboardUrl ? `\n${this.dashboardUrl.replace(/\/$/, '')}/app/agents/inbox` : '';
    const title = i.alert ? i.alert.title : i.title;
    const body = i.alert ? i.alert.body : i.body;
    try {
      await this.alert(`${i.severity === 'critical' ? '🚨' : i.severity === 'action' ? '🟡' : '🤖'} ${title}${body ? `\n\n${body.slice(0, 1500)}` : ''}${link}`);
    } catch { /* the stored item is what matters */ }
  }

  async list(o: { unreadOnly?: boolean; limit?: number } = {}): Promise<InboxItem[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM agent_inbox WHERE ($1::bool IS NOT TRUE OR read_at IS NULL) ORDER BY created_at DESC LIMIT $2`,
      [o.unreadOnly ?? false, o.limit ?? 100]);
    return rows.map(toItem);
  }

  /** One note (the dashboard's action answer), or null. */
  async get(id: number): Promise<InboxItem | null> {
    const { rows } = await this.pool.query(`SELECT * FROM agent_inbox WHERE id = $1`, [id]);
    return rows[0] ? toItem(rows[0]) : null;
  }

  async markRead(ids: number[] | 'all'): Promise<number> {
    const { rowCount } = ids === 'all'
      ? await this.pool.query(`UPDATE agent_inbox SET read_at = now() WHERE read_at IS NULL`)
      : await this.pool.query(`UPDATE agent_inbox SET read_at = now() WHERE id = ANY($1::bigint[]) AND read_at IS NULL`, [ids]);
    return rowCount ?? 0;
  }
}
