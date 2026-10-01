import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { AgentLoop, AgentLoopEvent, AgentLoopResult } from '../harness/agent-loop';
import type { ToolRegistry } from '../harness/tool-registry';
import type { ChatMessage } from '../llm/llm.types';
import { resolveModel } from '../llm/model-registry';
import type { SkillLibrary } from '../skills/skill-library';
import type { EditorMemoryRepository } from '../repo/editor-memory.repository';
import type { EditorChatMessage, EditorChatRepository, EditorDraft } from '../repo/editor-chat.repository';
import { buildComposerSystemPrompt } from '../roles/prompts';
import type { DraftsService } from './drafts.service';
import type { ComposerExtras } from './composer-tools';
import { hasPublishIntent, mentionedChannels } from './intent';

export const COMPOSER_MAX_STEPS = 16;
export const MAX_MESSAGE_CHARS = 8000;
const HISTORY_MESSAGES = 20;
const TITLE_CHARS = 60;

/** NDJSON events of POST /api/editor/chats/:id/messages (spec 010 FR-006). */
export type ChatStreamEvent =
  | { type: 'text';        text: string }
  | { type: 'tool_call';   name: string; args: unknown }
  | { type: 'tool_result'; name: string; ok: boolean; summary: string }
  | { type: 'draft';       draft: EditorDraft }
  | { type: 'message';     message: EditorChatMessage }
  | { type: 'error';       error: string }
  | { type: 'done' };

export interface EditorChatDeps {
  repo:     Pick<EditorChatRepository,
    'createChat' | 'listChats' | 'getChat' | 'deleteChat' | 'touchChat' | 'addMessage' | 'listMessages' | 'listDrafts' | 'myChannels'>;
  drafts:   Pick<DraftsService, 'resolveCard'>;
  memory:   Pick<EditorMemoryRepository, 'listActive'>;
  loop:     Pick<AgentLoop, 'run'>;
  registry: Pick<ToolRegistry, 'forRole'>;
  skills:   SkillLibrary;
  env:      (key: string) => string | undefined;
  /** The chat needs an LLM key only; it does not depend on EDITOR_ENABLED. */
  enabled:  () => boolean;
  now?:     () => Date;
}

export interface SendOptions {
  /** Channel picked in the UI (optional; "Канал: @x" in the text works too). */
  channel?: string | null;
  onEvent?: (e: ChatStreamEvent) => void;
}

const draftLine = (d: EditorDraft) =>
  `${d.id} · ${d.channelKey} · ${(d.spec as any)?.format ?? '?'} · «${(d.spec as any)?.title ?? ''}» · ${d.status}${d.scheduledAt ? ` на ${d.scheduledAt.toISOString()}` : ''}`;

function failureText(r: AgentLoopResult): string {
  switch (r.status) {
    case 'disabled':        return 'Чат вимкнено: не задано OPENROUTER_API_KEY.';
    case 'budget_exceeded': return `Денний бюджет LLM вичерпано (${r.error ?? ''}). Спробуй завтра або підніми EDITOR_DAILY_BUDGET_USD.`;
    case 'max_steps':       return `Я не встиг завершити за ${COMPOSER_MAX_STEPS} кроків. Напиши «продовжуй» або уточни задачу.`;
    default:                return `Сталася помилка: ${r.error ?? r.status}.`;
  }
}

/**
 * Conversations with the composer agent (spec 010). One message = one AgentLoop
 * run with the chat's prior text turns as history. Drafts and every side effect
 * go through the composer tools → DraftsService; this service only persists the
 * conversation and streams progress.
 */
export class EditorChatService {
  private readonly running = new Set<string>();

  constructor(private readonly d: EditorChatDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  async createChat() {
    return this.d.repo.createChat();
  }

  async listChats() {
    return this.d.repo.listChats(100);
  }

  async getChat(id: string) {
    const chat = await this.d.repo.getChat(id);
    if (!chat) throw new NotFoundException({ error: 'chat_not_found' });
    const [messages, drafts] = await Promise.all([this.d.repo.listMessages(id), this.d.repo.listDrafts({ chatId: id, limit: 200 })]);
    return { chat, messages, drafts, enabled: this.d.enabled() };
  }

  async deleteChat(id: string) {
    if (!(await this.d.repo.deleteChat(id))) throw new NotFoundException({ error: 'chat_not_found' });
    return { ok: true };
  }

  /** Pre-flight checks that must fail as a plain HTTP error before any streaming starts. */
  async validateSend(chatId: string, text: unknown, o: { busyOk?: boolean } = {}): Promise<string> {
    if (!this.d.enabled()) throw new ServiceUnavailableException({ error: 'chat_disabled', details: 'OPENROUTER_API_KEY is not set' });
    const t = typeof text === 'string' ? text.trim() : '';
    if (!t || t.length > MAX_MESSAGE_CHARS) throw new BadRequestException({ error: 'invalid_text', details: `1–${MAX_MESSAGE_CHARS} characters` });
    if (!(await this.d.repo.getChat(chatId))) throw new NotFoundException({ error: 'chat_not_found' });
    if (!o.busyOk && this.running.has(chatId)) throw new ConflictException({ error: 'chat_busy', details: 'the agent is still answering in this chat' });
    return t;
  }

  /**
   * Save the owner's message, run the composer, save its answer. Never throws
   * after validation: failures become an assistant message (and an error event).
   */
  async sendMessage(chatId: string, rawText: unknown, opts: SendOptions = {}): Promise<{ message: EditorChatMessage; drafts: EditorDraft[] }> {
    if (this.running.has(chatId)) throw new ConflictException({ error: 'chat_busy', details: 'the agent is still answering in this chat' });
    const emit = (e: ChatStreamEvent) => {
      if (!opts.onEvent) return;
      try { opts.onEvent(e); } catch { /* a closed stream never stops the run */ }
    };
    this.running.add(chatId); // synchronously, so a second request for the same chat is refused
    try {
      const text = await this.validateSend(chatId, rawText, { busyOk: true });
      const prior = await this.d.repo.listMessages(chatId, HISTORY_MESSAGES);
      const chatDrafts = await this.d.repo.listDrafts({ chatId, limit: 200 });
      await this.d.repo.addMessage({ chatId, role: 'user', content: text });
      await this.d.repo.touchChat(chatId, prior.length ? undefined : text.replace(/\s+/g, ' ').slice(0, TITLE_CHARS));

      const channelKey = await this.resolveChannel(text, opts.channel ?? null, prior, chatDrafts);
      const resolved = channelKey ? await this.d.drafts.resolveCard(channelKey) : null;
      const memory = channelKey && resolved?.hasCard ? await this.d.memory.listActive(channelKey) : [];

      const touched = new Map<string, EditorDraft>();
      const extras: ComposerExtras = {
        chat: { chatId, channelKey },
        card: resolved?.card,
        userIntent: hasPublishIntent(text),
        onDraft: (draft) => { touched.set(draft.id, draft); emit({ type: 'draft', draft }); },
      };
      const onEvent = (e: AgentLoopEvent) => {
        if (e.type === 'llm_text') emit({ type: 'text', text: e.text });
        else emit(e);
      };

      let res: AgentLoopResult;
      try {
        res = await this.d.loop.run({
          role: 'composer', channelKey: null, model: resolveModel('composer', this.d.env),
          system: buildComposerSystemPrompt({ now: this.now(), card: resolved?.card ?? null, hasCard: !!resolved?.hasCard, memory, skills: this.d.skills }),
          user: text, history: this.history(prior, chatDrafts), tools: this.d.registry.forRole('composer'),
          maxSteps: COMPOSER_MAX_STEPS, extras: extras as unknown as Record<string, unknown>, onEvent,
        });
      } catch (err: any) {
        res = { runId: null, status: 'error', totals: { steps: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 }, error: err?.message ?? String(err) };
      }
      const ok = res.status === 'ok' && !!res.finalText?.trim();
      if (!ok) emit({ type: 'error', error: res.error ?? res.status });
      const message = await this.d.repo.addMessage({
        chatId, role: 'assistant', content: ok ? res.finalText!.trim() : failureText(res), draftIds: [...touched.keys()], runId: res.runId,
      });
      await this.d.repo.touchChat(chatId);
      emit({ type: 'message', message });
      return { message, drafts: [...touched.values()] };
    } finally {
      this.running.delete(chatId);
    }
  }

  /** Prior text turns; an assistant turn carries a summary of the drafts it touched (ids for later edits). */
  private history(prior: EditorChatMessage[], drafts: EditorDraft[]): ChatMessage[] {
    const byId = new Map(drafts.map((x) => [x.id, x]));
    return prior.map((m) => {
      if (m.role === 'user') return { role: 'user', content: m.content };
      const lines = m.draftIds.map((id) => byId.get(id)).filter((x): x is EditorDraft => !!x).map(draftLine);
      return { role: 'assistant', content: lines.length ? `${m.content}\n\n[чернетки: ${lines.join('; ')}]` : m.content };
    });
  }

  /**
   * The chat's channel: the UI pick, else the latest own channel mentioned in
   * this message, else the chat's latest draft, else the latest mention earlier.
   */
  private async resolveChannel(text: string, picked: string | null, prior: EditorChatMessage[], drafts: EditorDraft[]): Promise<string | null> {
    const known = new Set((await this.d.repo.myChannels()).map((c) => c.channelKey));
    if (picked && known.has(picked)) return picked;
    const now = mentionedChannels(text).find((k) => known.has(k));
    if (now) return now;
    const latestDraft = [...drafts].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
    if (latestDraft) return latestDraft.channelKey;
    for (const m of [...prior].reverse()) {
      if (m.role !== 'user') continue;
      const k = mentionedChannels(m.content).find((x) => known.has(x));
      if (k) return k;
    }
    return null;
  }
}
