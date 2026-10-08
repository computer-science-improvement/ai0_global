import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { AgentLoop, AgentLoopEvent, AgentLoopResult } from '../harness/agent-loop';
import type { ToolRegistry } from '../harness/tool-registry';
import type { ChatMessage } from '../llm/llm.types';
import { resolveModel } from '../llm/model-registry';
import { readDefaultModel } from '../llm/model-defaults';
import type { SkillLibrary } from '../skills/skill-library';
import type { EditorMemoryRepository } from '../repo/editor-memory.repository';
import type { EditorChatMessage, EditorChatRepository, EditorDraft } from '../repo/editor-chat.repository';
import { buildComposerSystemPrompt } from '../roles/prompts';
import type { DraftsService } from './drafts.service';
import { renderDraft } from './drafts.service';
import type { EditorCard } from '../card';
import type { ComposerExtras } from './composer-tools';
import { hasPublishIntent, mentionedChannels } from './intent';
import type { Agent } from '../agents/agent.types';
import type { RunAgentContext } from '../agents/agent-runtime';
import type { PendingAction } from '../agents/pending-actions';
import type { ResourceProfile } from '../agents/resource-profile';
import type { AgentChatExtras } from '../agents/builder-tools';
import { hasAgentChangeIntent, parseMentions, startsWithMention } from '../agents/mentions';
import { agentPersona, buildBuilderPrompt, buildManagerChatPrompt } from '../agents/agent-prompts';
import type { EditorRole } from '../llm/llm.types';

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
  | { type: 'agent';       agent: { id: string; handle: string; name: string; emoji: string | null; kind: string } }
  | { type: 'action';      action: PendingAction }
  | { type: 'error';       error: string }
  | { type: 'done' };

/** The agent registry as the chat sees it (spec 018). Optional: without it the chat is the 010 composer. */
export interface AgentChatPort {
  byHandle(handle: string): Promise<Agent | null>;
  get(id: string): Promise<Agent | null>;
  forAgent(agent: Agent, role: EditorRole): Promise<RunAgentContext>;
  profileOf(agent: Agent): Promise<ResourceProfile | null>;
  /** The Telegram channel an orchestrator publishes to (its resource, or its network's channel). */
  channelKeyOf(agent: Agent): Promise<string | null>;
  agentsSummary(): Promise<string>;
  handles(): Promise<string[]>;
  managerDigest?(): Promise<string | null>;
  actionsForChat(chatId: string): Promise<PendingAction[]>;
}

type Route =
  | { kind: 'legacy' }
  | { kind: 'unknown'; handle: string }
  | { kind: 'agent'; agent: Agent; note: string | null };

export interface EditorChatDeps {
  repo:     Pick<EditorChatRepository,
    'createChat' | 'listChats' | 'getChat' | 'deleteChat' | 'touchChat' | 'addMessage' | 'listMessages' | 'listDrafts' | 'myChannels'>
    & Partial<Pick<EditorChatRepository, 'setChatAgent'>>;
  agents?:  AgentChatPort;
  drafts:   Pick<DraftsService, 'resolveCard'> & Partial<Pick<DraftsService, 'withRender'>>;
  memory:   Pick<EditorMemoryRepository, 'listActive'>;
  loop:     Pick<AgentLoop, 'run'>;
  registry: Pick<ToolRegistry, 'forRole'>;
  skills:   SkillLibrary;
  env:      (key: string) => string | undefined;
  /** The owner's global default model (spec 035, app_settings `ai.default_model`); cached by ModelDefaultsStore. */
  defaultModel?: () => Promise<string | null>;
  /** The chat needs an LLM key only; it does not depend on EDITOR_ENABLED. */
  enabled:  () => boolean;
  now?:     () => Date;
}

export interface SendOptions {
  /** Channel picked in the UI (optional; "Channel: @x" or any @channel mention in the text works too). */
  channel?: string | null;
  onEvent?: (e: ChatStreamEvent) => void;
}

const draftLine = (d: EditorDraft) =>
  `${d.id} · ${d.channelKey} · ${(d.spec as any)?.format ?? '?'} · «${(d.spec as any)?.title ?? ''}» · ${d.status}${d.scheduledAt ? ` на ${d.scheduledAt.toISOString()}` : ''}`;

const CAP_LABELS: Record<string, string> = {
  total:    'total daily AI cap (AI_DAILY_BUDGET_USD)',
  global:   'agents daily cap (EDITOR_DAILY_BUDGET_USD)',
  channel:  'resource daily cap (EDITOR_CHANNEL_DAILY_BUDGET_USD or the channel cap)',
  agent:    'agent daily cap',
  feature:  'feature daily cap',
  provider: 'provider daily cap',
};

/** The refusal of an owner message over a blocking cap (spec 029 FR-008): names the cap, never silent. */
export function budgetRefusalText(error: string | null | undefined): string {
  const m = /^(\w+) budget: \$([\d.]+) >= \$([\d.]+)/.exec(error ?? '');
  const what = m ? (CAP_LABELS[m[1]] ?? m[1]) : (error ?? 'daily cap');
  const spent = m ? `: spent $${Number(m[2]).toFixed(3)} of $${m[3]}` : '';
  return `Message not processed — ${what} reached${spent} (Kyiv day). `
    + 'Work resumes at midnight Kyiv time, or as soon as the cap is raised on Spend → Budgets (/app/spend?tab=budgets).';
}

export function failureText(r: AgentLoopResult): string {
  switch (r.status) {
    case 'disabled':        return 'Chat is off: OPENROUTER_API_KEY is not set.';
    case 'budget_exceeded': return budgetRefusalText(r.error);
    case 'max_steps':       return `I could not finish within ${COMPOSER_MAX_STEPS} steps. Say "continue" or narrow the task down.`;
    default:                return `Something went wrong: ${r.error ?? r.status}.`;
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

  /** Channels the chat can post to (the UI's channel picker; same list as list_my_channels). */
  async listChannels() {
    return this.d.repo.myChannels();
  }

  async getChat(id: string) {
    const chat = await this.d.repo.getChat(id);
    if (!chat) throw new NotFoundException({ error: 'chat_not_found' });
    const [messages, drafts, actions] = await Promise.all([
      this.d.repo.listMessages(id), this.d.repo.listDrafts({ chatId: id, limit: 200 }),
      this.d.agents ? this.d.agents.actionsForChat(id) : Promise.resolve([] as PendingAction[]),
    ]);
    const rendered = this.d.drafts.withRender ? await Promise.all(drafts.map((x) => this.d.drafts.withRender!(x))) : drafts;
    return { chat, messages, drafts: rendered, actions, enabled: this.d.enabled() };
  }

  /** Who a message goes to (spec 018 FR-002): the first @agent mention, else the chat's last agent, else the composer. */
  private async route(text: string, picked: string | null, chatAgentId: string | null): Promise<Route> {
    const ag = this.d.agents;
    if (!ag) return { kind: 'legacy' };
    const mentions = parseMentions(text);
    for (const m of mentions) {
      const a = await ag.byHandle(m.handle);
      if (!a) continue;
      const others = mentions.filter((x) => x.handle !== m.handle).length;
      if (a.parentId) {
        const parent = await ag.get(a.parentId);
        if (parent) return { kind: 'agent', agent: parent, note: `@${a.handle} — роль агента @${parent.handle}; відповідає @${parent.handle}.` };
      }
      return { kind: 'agent', agent: a, note: others ? 'Інші згадки в повідомленні — це дані, адресат один (перший).' : null };
    }
    if (mentions.length && startsWithMention(text, mentions[0].handle)) {
      const known = new Set((await this.d.repo.myChannels()).map((c) => c.channelKey.toLowerCase()));
      if (!known.has(`@${mentions[0].handle}`)) return { kind: 'unknown', handle: mentions[0].handle };
    }
    if (picked) return { kind: 'legacy' };
    if (chatAgentId) {
      const a = await ag.get(chatAgentId);
      if (a) return { kind: 'agent', agent: a, note: null };
    }
    return { kind: 'legacy' };
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
      const chat = await this.d.repo.getChat(chatId);
      const route = await this.route(text, opts.channel ?? null, chat?.agentId ?? null);
      const addressee = route.kind === 'agent' ? route.agent : null;
      await this.d.repo.addMessage({ chatId, role: 'user', content: text, agentId: addressee?.id ?? null });
      await this.d.repo.touchChat(chatId, prior.length ? undefined : text.replace(/\s+/g, ' ').slice(0, TITLE_CHARS));

      if (route.kind === 'unknown') {
        const handles = this.d.agents ? await this.d.agents.handles() : [];
        const message = await this.d.repo.addMessage({
          chatId, role: 'assistant',
          content: `There is no agent @${route.handle}.${handles.length ? ` Available: ${handles.map((h) => `@${h}`).join(', ')}.` : ''}`,
        });
        emit({ type: 'message', message });
        return { message, drafts: [] };
      }
      if (addressee) {
        if (this.d.repo.setChatAgent && addressee.id !== chat?.agentId) await this.d.repo.setChatAgent(chatId, addressee.id);
        emit({ type: 'agent', agent: { id: addressee.id, handle: addressee.handle, name: addressee.name, emoji: addressee.emoji, kind: addressee.kind } });
        if (addressee.kind === 'builder' || addressee.kind === 'manager') {
          return await this.runSystemAgent(chatId, text, addressee, prior, chatDrafts, emit, route.kind === 'agent' ? route.note : null);
        }
      }

      const agentKey = addressee && this.d.agents ? await this.d.agents.channelKeyOf(addressee) : null;
      const channelKey = agentKey ?? await this.resolveChannel(text, opts.channel ?? null, prior, chatDrafts);
      const resolved = channelKey ? await this.d.drafts.resolveCard(channelKey) : null;
      const memory = channelKey && resolved?.hasCard ? await this.d.memory.listActive(channelKey) : [];
      const agentCtx = addressee && this.d.agents ? await this.d.agents.forAgent(addressee, 'composer') : null;
      const persona = addressee && this.d.agents
        ? agentPersona(addressee, await this.d.agents.profileOf(addressee), route.kind === 'agent' && route.note ? [route.note] : [])
        : null;

      const touched = new Map<string, EditorDraft>();
      const actions: PendingAction[] = [];
      const extras: ComposerExtras & AgentChatExtras & Record<string, unknown> = {
        chat: { chatId, channelKey },
        card: resolved?.card,
        userIntent: hasPublishIntent(text),
        // The card in extras is the draft's channel card (save_draft switches it), so the preview renders like the post.
        onDraft: (draft) => { touched.set(draft.id, draft); emit({ type: 'draft', draft: renderDraft(draft, (extras.card as EditorCard | undefined) ?? null) }); },
        agentIntent: hasAgentChangeIntent(text),
        ownerText: text,
        onAction: (a) => { actions.push(a); emit({ type: 'action', action: a }); },
        ...(agentCtx ? { agent: addressee, skills: agentCtx.skills } : {}),
      };
      const onEvent = (e: AgentLoopEvent) => {
        if (e.type === 'llm_text') emit({ type: 'text', text: e.text });
        else emit(e);
      };

      let res: AgentLoopResult;
      try {
        res = await this.d.loop.run({
          role: 'composer', channelKey: null,
          model: resolveModel('composer', this.d.env, null, {
            agentModel: addressee?.model, defaultModel: await readDefaultModel(this.d.defaultModel), reasoningEffort: addressee?.reasoningEffort,
          }),
          system: buildComposerSystemPrompt({
            now: this.now(), card: resolved?.card ?? null, hasCard: !!resolved?.hasCard, memory, skills: agentCtx?.skills ?? this.d.skills, persona,
          }),
          user: text, history: this.history(prior, chatDrafts), tools: this.d.registry.forRole('composer'),
          maxSteps: COMPOSER_MAX_STEPS, extras: extras as unknown as Record<string, unknown>, onEvent,
          agent: addressee ? { id: addressee.id, handle: addressee.handle, limitUsd: addressee.dailyBudgetUsd } : null,
        });
      } catch (err: any) {
        res = { runId: null, status: 'error', totals: { steps: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 }, error: err?.message ?? String(err) };
      }
      const ok = res.status === 'ok' && !!res.finalText?.trim();
      if (!ok) emit({ type: 'error', error: res.error ?? res.status });
      const message = await this.d.repo.addMessage({
        chatId, role: 'assistant', content: ok ? res.finalText!.trim() : failureText(res), draftIds: [...touched.keys()], runId: res.runId,
        agentId: addressee?.id ?? null,
      });
      await this.d.repo.touchChat(chatId);
      emit({ type: 'message', message });
      return { message, drafts: [...touched.values()] };
    } finally {
      this.running.delete(chatId);
    }
  }

  /** @ai0 (builder) and @manager: their own prompts and tools; mutations only as confirmation cards. */
  private async runSystemAgent(
    chatId: string, text: string, agent: Agent, prior: EditorChatMessage[], chatDrafts: EditorDraft[],
    emit: (e: ChatStreamEvent) => void, note: string | null,
  ): Promise<{ message: EditorChatMessage; drafts: EditorDraft[] }> {
    const ag = this.d.agents!;
    const role: EditorRole = agent.kind === 'builder' ? 'builder' : 'manager';
    const ctx = await ag.forAgent(agent, role);
    const system = role === 'builder'
      ? buildBuilderPrompt({ now: this.now(), skills: ctx.skills, agentsSummary: await ag.agentsSummary() })
      : buildManagerChatPrompt({ now: this.now(), skills: ctx.skills, agent, digest: ag.managerDigest ? await ag.managerDigest() : null });
    const extras: AgentChatExtras & Record<string, unknown> = {
      chat: { chatId, channelKey: null },
      agentIntent: hasAgentChangeIntent(text),
      ownerText: text,
      onAction: (a) => emit({ type: 'action', action: a }),
      agent, skills: ctx.skills,
    };
    const onEvent = (e: AgentLoopEvent) => {
      if (e.type === 'llm_text') emit({ type: 'text', text: e.text });
      else emit(e);
    };
    let res: AgentLoopResult;
    try {
      res = await this.d.loop.run({
        role, channelKey: null, model: resolveModel(role, this.d.env, null, { agentModel: agent.model, defaultModel: await readDefaultModel(this.d.defaultModel), reasoningEffort: agent.reasoningEffort }),
        system: note ? `${system}\n\n${note}` : system,
        user: text, history: this.history(prior, chatDrafts), tools: this.d.registry.forRole(role),
        maxSteps: COMPOSER_MAX_STEPS, extras, onEvent,
        agent: { id: agent.id, handle: agent.handle, limitUsd: agent.dailyBudgetUsd },
      });
    } catch (err: any) {
      res = { runId: null, status: 'error', totals: { steps: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 }, error: err?.message ?? String(err) };
    }
    const ok = res.status === 'ok' && !!res.finalText?.trim();
    if (!ok) emit({ type: 'error', error: res.error ?? res.status });
    const message = await this.d.repo.addMessage({
      chatId, role: 'assistant', content: ok ? res.finalText!.trim() : failureText(res), runId: res.runId, agentId: agent.id,
    });
    await this.d.repo.touchChat(chatId);
    emit({ type: 'message', message });
    return { message, drafts: [] };
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
