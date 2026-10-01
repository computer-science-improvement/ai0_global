import type { Pool } from 'pg';
import type { LintResult } from '../post/lint-post';

export const DRAFT_STATUSES = ['draft', 'scheduled', 'published', 'failed', 'canceled'] as const;
export type DraftStatus = typeof DRAFT_STATUSES[number];

export interface EditorChat {
  id:        string;
  title:     string;
  createdAt: Date;
  updatedAt: Date;
}

export interface EditorChatMessage {
  id:        number;
  chatId:    string;
  role:      'user' | 'assistant';
  content:   string;
  draftIds:  string[];
  runId:     string | null;
  createdAt: Date;
}

export interface EditorDraft {
  id:              string;
  chatId:          string | null;
  channelKey:      string;
  spec:            unknown;
  preview:         string | null;
  lint:            LintResult | null;
  status:          DraftStatus;
  scheduledAt:     Date | null;
  slotId:          string | null;
  publishedPostId: number | null;
  error:           string | null;
  createdAt:       Date;
  updatedAt:       Date;
}

export interface DraftPatch {
  channelKey?:      string;
  spec?:            unknown;
  preview?:         string | null;
  lint?:            LintResult | null;
  status?:          DraftStatus;
  scheduledAt?:     Date | null;
  slotId?:          string | null;
  publishedPostId?: number | null;
  error?:           string | null;
}

export interface MyChannel {
  channelKey: string;
  title:      string | null;
  hasCard:    boolean;
  mode:       string | null;
}

const toChat = (r: any): EditorChat => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at });

const toMessage = (r: any): EditorChatMessage => ({
  id: Number(r.id), chatId: r.chat_id, role: r.role, content: r.content, draftIds: r.draft_ids ?? [],
  runId: r.run_id ?? null, createdAt: r.created_at,
});

export const toDraft = (r: any): EditorDraft => ({
  id: r.id, chatId: r.chat_id ?? null, channelKey: r.channel_key, spec: r.spec, preview: r.preview ?? null,
  lint: r.lint ?? null, status: r.status, scheduledAt: r.scheduled_at ? new Date(r.scheduled_at) : null,
  slotId: r.slot_id ?? null, publishedPostId: r.published_post_id == null ? null : Number(r.published_post_id),
  error: r.error ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
});

/** Editor chat storage (spec 010): chats, their messages and the drafts the composer saves. */
export class EditorChatRepository {
  constructor(private readonly pool: Pool) {}

  // ── chats ─────────────────────────────────────────────────────────────────

  async createChat(title?: string | null): Promise<EditorChat> {
    const { rows } = await this.pool.query(
      `INSERT INTO editor_chats (title) VALUES (COALESCE($1, 'New chat')) RETURNING *`, [title ?? null]);
    return toChat(rows[0]);
  }

  async listChats(limit = 50): Promise<EditorChat[]> {
    const { rows } = await this.pool.query(`SELECT * FROM editor_chats ORDER BY updated_at DESC LIMIT $1`, [limit]);
    return rows.map(toChat);
  }

  async getChat(id: string): Promise<EditorChat | null> {
    const { rows } = await this.pool.query(`SELECT * FROM editor_chats WHERE id = $1`, [id]);
    return rows[0] ? toChat(rows[0]) : null;
  }

  async deleteChat(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM editor_chats WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }

  /** Bump updated_at; set the title only while it is still the default. */
  async touchChat(id: string, title?: string): Promise<void> {
    await this.pool.query(
      `UPDATE editor_chats SET updated_at = now(),
              title = CASE WHEN $2::text IS NOT NULL AND title IN ('New chat', 'Новий чат') THEN $2 ELSE title END
        WHERE id = $1`, [id, title ?? null]);
  }

  // ── messages ──────────────────────────────────────────────────────────────

  async addMessage(m: { chatId: string; role: 'user' | 'assistant'; content: string; draftIds?: string[]; runId?: string | null }): Promise<EditorChatMessage> {
    const { rows } = await this.pool.query(
      `INSERT INTO editor_chat_messages (chat_id, role, content, draft_ids, run_id) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [m.chatId, m.role, m.content, m.draftIds ?? [], m.runId ?? null]);
    return toMessage(rows[0]);
  }

  /** The chat's messages in order (the last `limit`). */
  async listMessages(chatId: string, limit = 200): Promise<EditorChatMessage[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM (SELECT * FROM editor_chat_messages WHERE chat_id = $1 ORDER BY id DESC LIMIT $2) x ORDER BY id`,
      [chatId, limit]);
    return rows.map(toMessage);
  }

  // ── drafts ────────────────────────────────────────────────────────────────

  async insertDraft(d: { chatId: string | null; channelKey: string; spec: unknown; preview: string | null; lint: LintResult | null }): Promise<EditorDraft> {
    const { rows } = await this.pool.query(
      `INSERT INTO editor_drafts (chat_id, channel_key, spec, preview, lint) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [d.chatId, d.channelKey, JSON.stringify(d.spec), d.preview, d.lint ? JSON.stringify(d.lint) : null]);
    return toDraft(rows[0]);
  }

  async updateDraft(id: string, p: DraftPatch): Promise<EditorDraft | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (p.channelKey !== undefined)      add('channel_key', p.channelKey);
    if (p.spec !== undefined)            add('spec', JSON.stringify(p.spec));
    if (p.preview !== undefined)         add('preview', p.preview);
    if (p.lint !== undefined)            add('lint', p.lint === null ? null : JSON.stringify(p.lint));
    if (p.status !== undefined)          add('status', p.status);
    if (p.scheduledAt !== undefined)     add('scheduled_at', p.scheduledAt);
    if (p.slotId !== undefined)          add('slot_id', p.slotId);
    if (p.publishedPostId !== undefined) add('published_post_id', p.publishedPostId);
    if (p.error !== undefined)           add('error', p.error);
    const { rows } = await this.pool.query(
      `UPDATE editor_drafts SET ${[...sets, 'updated_at = now()'].join(', ')} WHERE id = $1 RETURNING *`, params);
    return rows[0] ? toDraft(rows[0]) : null;
  }

  async getDraft(id: string): Promise<EditorDraft | null> {
    const { rows } = await this.pool.query(`SELECT * FROM editor_drafts WHERE id = $1`, [id]);
    return rows[0] ? toDraft(rows[0]) : null;
  }

  async findDraftBySlot(slotId: string): Promise<EditorDraft | null> {
    const { rows } = await this.pool.query(`SELECT * FROM editor_drafts WHERE slot_id = $1`, [slotId]);
    return rows[0] ? toDraft(rows[0]) : null;
  }

  /** Scheduled drafts soonest first; everything else newest first. */
  async listDrafts(f: { status?: DraftStatus | null; chatId?: string | null; limit?: number } = {}): Promise<EditorDraft[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM editor_drafts
        WHERE ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR chat_id = $2)
        ORDER BY CASE WHEN status = 'scheduled' THEN scheduled_at END ASC NULLS LAST, updated_at DESC
        LIMIT $3`,
      [f.status ?? null, f.chatId ?? null, f.limit ?? 50]);
    return rows.map(toDraft);
  }

  // ── channels the owner can post to ────────────────────────────────────────

  /** Own channels (tracked_channels.is_mine) plus any channel with an editor card, with card mode. */
  async myChannels(): Promise<MyChannel[]> {
    const { rows } = await this.pool.query(
      `SELECT k.channel_key, COALESCE(ec.title, tc.title) AS title, ec.channel_key IS NOT NULL AS has_card, ec.mode
         FROM (SELECT channel_key FROM tracked_channels WHERE is_mine AND channel_key IS NOT NULL
               UNION SELECT channel_key FROM editor_channels) k
         LEFT JOIN editor_channels ec ON ec.channel_key = k.channel_key
         LEFT JOIN LATERAL (SELECT title FROM tracked_channels t WHERE t.channel_key = k.channel_key ORDER BY t.is_mine DESC LIMIT 1) tc ON true
        ORDER BY k.channel_key`);
    return rows.map((r) => ({ channelKey: r.channel_key, title: r.title ?? null, hasCard: !!r.has_card, mode: r.mode ?? null }));
  }
}
