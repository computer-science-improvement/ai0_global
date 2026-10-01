import type { Pool } from 'pg';
import type { EditorDraft } from '../../src/editor/repo/editor-chat.repository';
import type { CaseCtx } from './case';
import { stepsOf, toolErrors } from './graders';

/** Remove the chat state a chat case may have created for this channel (scratch DB only). */
export async function resetChat(pool: Pool, key: string): Promise<void> {
  await pool.query(`DELETE FROM editor_chats WHERE id IN (SELECT chat_id FROM editor_drafts WHERE channel_key = $1)`, [key]);
  await pool.query(`DELETE FROM editor_drafts WHERE channel_key = $1`, [key]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [key]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [key]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [key]);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key = $1`, [key]);
}

/** An own channel (tracked_channels.is_mine) WITHOUT an editor card — the chat's default-card path. */
export async function ownChannel(pool: Pool, key: string, title: string): Promise<void> {
  await pool.query(
    `INSERT INTO tracked_channels (channel_key, username, title, is_mine, kind) VALUES ($1, $2, $3, true, 'public')`,
    [key, key.replace(/^@/, ''), title]);
}

/**
 * Send ONE owner message through the same EditorChatService the REST controller
 * uses (real LLM, fixture web, fake Telegram) and collect what the case grades.
 */
export async function sendChat(ctx: CaseCtx, text: string) {
  const chat = await ctx.stack.chat.createChat();
  const { message } = await ctx.stack.chat.sendMessage(chat.id, text);
  const { drafts } = await ctx.stack.chat.getChat(chat.id);
  const steps = await stepsOf(ctx.pool, message.runId);
  return {
    message,
    drafts: drafts as EditorDraft[],
    steps,
    toolErrors: toolErrors(steps),
    toolsUsed: steps.filter((x) => x.type === 'tool').map((x) => x.tool_name ?? '?'),
  };
}
