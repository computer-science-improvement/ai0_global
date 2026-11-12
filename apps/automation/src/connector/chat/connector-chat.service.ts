import type { PendingAction } from '../../editor/agents/pending-actions';
import type { EditorChat, EditorChatMessage } from '../../editor/repo/editor-chat.repository';
import { MESSAGE_MAX, clip, refuse } from '../tools/common';
import { reasonOfHttp } from '../posts/connector-posts.service';

/**
 * Talking to the network's agents from Claude (spec 103 §7): the owner chat with a bounded wait.
 *
 * A new chat is created with `created_via = 'connector'` (the dashboard shows it). The turn runs in the background with
 * `via: 'connector'`, which switches publishing off: the composer's publish_draft and schedule_draft always refuse in
 * these turns, whatever the text says. The cost caps are the chat's own (EDITOR_CHAT_TURN_MAX_USD); this adds no spend path.
 */

export const TALK_WAIT_DEFAULT_S = 60;
export const TALK_WAIT_MAX_S = 100;
export const READ_WAIT_MAX_S = 90;
export const MESSAGE_IN_MAX = 8000;
/** Messages a read returns at most (the newest). */
export const READ_MESSAGES_MAX = 20;

export interface ChatSnapshotSource {
  chat:     EditorChat;
  messages: EditorChatMessage[];
  drafts:   Array<{ id: string; channelKey: string; status: string; spec?: unknown; scheduledAt?: Date | null }>;
  actions:  PendingAction[];
}

export interface ConnectorChatPort {
  createChat(o: { createdVia: 'connector' }): Promise<EditorChat>;
  validateSend(chatId: string, text: unknown): Promise<string>;
  sendMessage(chatId: string, text: unknown, opts: { channel?: string | null; via: 'connector' }): Promise<unknown>;
  getChat(id: string): Promise<ChatSnapshotSource>;
  isRunning(id: string): boolean;
}

export interface ChatAgentsPort {
  /** Mentionable top-level agent handles (lowercase, no @). */
  handles(): Promise<string[]>;
  /** id → {handle, name} of every agent. */
  byId(): Promise<Map<string, { handle: string; name: string }>>;
}

export interface ConnectorChatDeps {
  chat:    ConnectorChatPort;
  agents:  ChatAgentsPort;
  log?:    (msg: string) => void;
  sleep?:  (ms: number) => Promise<void>;
  now?:    () => Date;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ConnectorChatService {
  constructor(private readonly d: ConnectorChatDeps) {}

  private sleep(ms: number) { return (this.d.sleep ?? defaultSleep)(ms); }

  /** A wait that can be cancelled, so a finished turn leaves no timer behind. */
  private timeout(ms: number): { promise: Promise<void>; cancel(): void } {
    if (this.d.sleep) return { promise: this.d.sleep(ms), cancel: () => {} };
    let t: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<void>((r) => { t = setTimeout(r, ms); });
    return { promise, cancel: () => { if (t) clearTimeout(t); } };
  }

  async talk(i: { message: string; agent?: string; chatId?: string; channel?: string | null; waitSeconds?: number }) {
    const wait = Math.min(Math.max(i.waitSeconds ?? TALK_WAIT_DEFAULT_S, 0), TALK_WAIT_MAX_S);
    let text = i.message.trim();
    if (i.agent) {
      const handle = i.agent.trim().replace(/^@/, '').toLowerCase();
      const known = await this.d.agents.handles();
      if (!known.includes(handle)) refuse(`There is no agent @${clip(handle, 40)}.`, `agents: ${known.map((h) => `@${h}`).join(', ') || 'none'}`);
      if (!text.toLowerCase().startsWith(`@${handle}`)) text = `@${handle} ${text}`;
    }
    if (text.length > MESSAGE_IN_MAX) refuse(`The message is too long once @handle is added (${text.length} of ${MESSAGE_IN_MAX} characters).`, 'shorten it');
    let chatId = i.chatId;
    if (chatId) {
      const found = await this.d.chat.getChat(chatId).catch(() => null);
      if (!found) refuse(`No chat ${clip(chatId, 60)}.`, 'omit chat_id to start a new chat');
      if (found.chat.createdVia !== 'connector') refuse('That chat was not started from Claude.', 'omit chat_id to start a new chat; read_agent_chat can read any chat');
    } else {
      chatId = (await this.d.chat.createChat({ createdVia: 'connector' })).id;
    }
    try {
      await this.d.chat.validateSend(chatId, text);
    } catch (err) { return reasonOfHttp(err); }
    const before = (await this.d.chat.getChat(chatId)).messages.at(-1)?.id ?? 0;
    // The turn runs on its own: Claude's call returns after the wait, and the chat finishes and saves its answer anyway.
    const turn = this.d.chat.sendMessage(chatId, text, { channel: i.channel ?? null, via: 'connector' })
      .then(() => 'done' as const, (err) => { this.d.log?.(`connector chat turn failed: ${err?.message ?? err}`); return 'done' as const; });
    const timer = this.timeout(wait * 1000);
    try { await Promise.race([turn, timer.promise]); } finally { timer.cancel(); }
    return this.snapshot(chatId, before, { publishingNote: true });
  }

  async read(i: { chatId: string; afterMessageId?: number; waitSeconds?: number }) {
    const wait = Math.min(Math.max(i.waitSeconds ?? 0, 0), READ_WAIT_MAX_S);
    const found = await this.d.chat.getChat(i.chatId).catch(() => null);
    if (!found) refuse(`No chat ${clip(i.chatId, 60)}.`, 'chat ids come from talk_to_agent');
    let waited = 0;
    while (waited < wait && this.d.chat.isRunning(i.chatId)) {
      await this.sleep(1000);
      waited++;
    }
    return this.snapshot(i.chatId, i.afterMessageId ?? 0, {});
  }

  /** The chat as a compact result: the messages after `after`, their cards and drafts, and whether the agent is still answering. */
  private async snapshot(chatId: string, after: number, o: { publishingNote?: boolean }) {
    const src = await this.d.chat.getChat(chatId);
    const names = await this.d.agents.byId().catch(() => new Map<string, { handle: string; name: string }>());
    const all = src.messages.filter((m) => m.id > after && m.role === 'assistant');
    const msgs = all.slice(-READ_MESSAGES_MAX);
    const actionOf = new Map(src.actions.map((a) => [a.id, a]));
    const draftOf = new Map(src.drafts.map((d) => [d.id, d]));
    const running = this.d.chat.isRunning(chatId);
    const messages = msgs.map((m) => ({
      id: m.id, role: m.role, agent: m.agentId ? names.get(m.agentId)?.handle ?? null : null,
      text: clip(m.content, MESSAGE_MAX), at: new Date(m.createdAt).toISOString(),
      cards: (m.actions?.cards ?? []).map((c) => {
        const a = actionOf.get(c.id);
        return { id: c.id, kind: c.kind, summary: clip(a?.summary ?? '', 400), status: a?.status ?? 'unknown' };
      }),
      drafts: (m.draftIds ?? []).map((id) => {
        const dr = draftOf.get(id);
        const spec = (dr?.spec ?? {}) as { title?: string; format?: string };
        return { id, channel: dr?.channelKey ?? null, status: dr?.status ?? 'unknown', format: spec.format ?? null, title: clip(spec.title ?? '', 200) };
      }),
    }));
    const pending = messages.flatMap((m) => m.cards).filter((c) => c.status === 'pending');
    const agentId = src.chat.agentId ?? null;
    return {
      chat_id: chatId, agent: agentId ? names.get(agentId)?.handle ?? null : null, running,
      messages, ...(all.length > msgs.length ? { truncated: true } : {}),
      next_after_message_id: src.messages.at(-1)?.id ?? after,
      untrusted_fields: ['messages[].text', 'messages[].cards[].summary', 'messages[].drafts[].title'],
      ...(running ? { hint: 'The agent is still answering: call read_agent_chat with this chat_id (and wait_seconds) for the reply.' } : {}),
      ...(pending.length ? { cards_waiting: pending.length, cards_hint: 'apply_card or discard_card decides a pending card; some kinds can only be applied in the dashboard.' } : {}),
      ...(o.publishingNote ? { note: 'Publishing is off in connector chats: drafts and cards are proposals. Use prepare_post to schedule a post.' } : {}),
    };
  }
}
