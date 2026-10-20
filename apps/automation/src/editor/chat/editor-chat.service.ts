import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { AgentLoop, AgentLoopEvent, AgentLoopInput, AgentLoopResult } from '../harness/agent-loop';
import { actionLine, claimRePrompt, historyTurn, NOT_DONE_NOTE, TurnRecorder, unbackedClaims } from './turn-record';
import type { ToolRegistry } from '../harness/tool-registry';
import type { ChatMessage } from '../llm/llm.types';
import { resolveModel } from '../llm/model-registry';
import { agentModelIn, readModelContext, type Workspace } from '../llm/workspace';
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
import { leadingMentions, parseMentions, startsWithMention } from '../agents/mentions';
import type { ArtifactChip, ArtifactType } from '../artifacts/artifact.types';
import { parseSlash, runSlash, type SlashCommand, type SlashContext, type SlashDeps, type SlashResult } from './slash-commands';
import { ownerChangeIntent } from './owner-intent';
import { contradictedDenials, denialNote, denialRePrompt, factsBlock, restatesFact, type ChatFacts } from './chat-facts';
import { agentPersona, buildBuilderPrompt, buildManagerChatPrompt } from '../agents/agent-prompts';
import type { EditorRole } from '../llm/llm.types';
import type { LoadoutService } from '../loadout/loadout.service';
import { chatFeature, CHAT_FEATURE_PREFIX } from '../../common/ai/usage/features';

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
  /** Spec 047 FR-003: the message goes to several agents, answering in this order. */
  | { type: 'addressees';  agents: Array<{ id: string; handle: string; name: string; emoji: string | null; kind: string }> }
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
  | { kind: 'agent'; agent: Agent; note: string | null }
  | { kind: 'agents'; agents: Agent[] };

export interface EditorChatDeps {
  repo:     Pick<EditorChatRepository,
    'createChat' | 'listChats' | 'getChat' | 'deleteChat' | 'touchChat' | 'addMessage' | 'listMessages' | 'listDrafts' | 'myChannels'>
    & Partial<Pick<EditorChatRepository, 'setChatAgent'>>;
  agents?:  AgentChatPort;
  drafts:   Pick<DraftsService, 'resolveCard'> & Partial<Pick<DraftsService, 'withRender'>>;
  memory:   Pick<EditorMemoryRepository, 'listActive'>;
  loop:     Pick<AgentLoop, 'run'>;
  registry: Pick<ToolRegistry, 'forRole'>;
  /** Spec 054: the addressed agent's own tool set; the chat-only and composer tools stay. Optional for tests. */
  loadout?: Pick<LoadoutService, 'allowFor'>;
  skills:   SkillLibrary;
  env:      (key: string) => string | undefined;
  /** The owner's global default model (spec 035, app_settings `ai.default_model`); cached by ModelDefaultsStore. */
  defaultModel?: (ws?: Workspace) => Promise<string | null>;
  /** Spec 038: the active model workspace. */
  workspace?: () => Promise<Workspace>;
  /** Spec 048 FR-003: slash commands, run in code without a model turn. */
  slash?:   SlashDeps;
  /** Spec 048 FR-005: an artifact as a message chip (its title and status now); null when it is gone. */
  artifactChip?: (type: ArtifactType, id: string) => Promise<ArtifactChip | null>;
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

/** Spec 047 FR-003: the least a further addressee needs of the shared turn cap; how much of each answer the next one reads. */
const MIN_ADDRESSEE_USD = 0.02;
const MAX_ADDRESSEES = 5;
const ANSWER_NOTE_CHARS = 600;
const agentRef = (a: Agent) => ({ id: a.id, handle: a.handle, name: a.name, emoji: a.emoji, kind: a.kind });

/** Spec 047 FR-002: the chat facts go last in the system prompt, after the cacheable part. */
const withFacts = (system: string, facts: string | null) => (facts ? `${system}\n\n${facts}` : system);

/** A chat turn's own spend cap (spec 040 FR-001); setting EDITOR_CHAT_TURN_MAX_USD, 0 = off. */
export const CHAT_TURN_MAX_USD = 0.3;

export function chatTurnCap(env: (key: string) => string | undefined): number | null {
  const raw = env('EDITOR_CHAT_TURN_MAX_USD')?.trim();
  const n = raw ? Number(raw) : CHAT_TURN_MAX_USD;
  if (!Number.isFinite(n)) return CHAT_TURN_MAX_USD;
  return n > 0 ? n : null;
}

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
  const m = /^(\w+) budget(?: \(([^)]+)\))?: \$([\d.]+) >= \$([\d.]+)/.exec(error ?? '');
  const what = !m ? (error ?? 'daily cap')
    : m[2] === CHAT_FEATURE_PREFIX ? `agents chat daily cap (${CHAT_FEATURE_PREFIX})`
    : `${CAP_LABELS[m[1]] ?? m[1]}${m[2] ? ` (${m[2]})` : ''}`;
  const spent = m ? `: spent $${Number(m[3]).toFixed(3)} of $${m[4]}` : '';
  return `Message not processed — ${what} reached${spent} (Kyiv day). `
    + 'Work resumes at midnight Kyiv time, or as soon as the cap is raised on Spend → Budgets (/app/spend?tab=budgets).';
}

/** The owner's last messages, oldest first, ending with this one (spec 040 FR-010: a rule is matched against them). */
export function ownerRecent(prior: Array<Pick<EditorChatMessage, 'role' | 'content'>>, text: string, n = 5): string[] {
  return [...prior.filter((m) => m.role === 'user').map((m) => m.content).slice(-(n - 1)), text];
}

/** The previous assistant turn of the chat (spec 040 FR-009: a short "yes" answers it). */
export function lastAssistantText(prior: Array<Pick<EditorChatMessage, 'role' | 'content'>>): string | null {
  for (let k = prior.length - 1; k >= 0; k--) if (prior[k].role === 'assistant') return prior[k].content;
  return null;
}

/** A turn stopped by its own cap (spec 040 FR-001): what it cost, how far it got and what it did. */
export function turnCapText(r: AgentLoopResult): string {
  const m = /^turn budget: \$([\d.]+) >= \$([\d.]+)/.exec(r.error ?? '');
  const cost = m ? ` ($${Number(m[1]).toFixed(3)} of $${m[2]})` : '';
  const done = [...new Set(r.toolsOk ?? [])];
  return `Stopped — this turn reached the per-turn chat cap${cost}; EDITOR_CHAT_TURN_MAX_USD in Settings → Configuration. `
    + (done.length ? `Done in this turn: ${done.join(', ')}.` : 'Nothing was changed in this turn.')
    + (r.lastText ? `\n\nWhere I stopped:\n${r.lastText}` : '')
    + '\n\nSay "continue" to go on, or narrow the task down.';
}

export function failureText(r: AgentLoopResult, drafts: readonly EditorDraft[] = []): string {
  switch (r.status) {
    case 'disabled':        return 'Chat is off: OPENROUTER_API_KEY is not set.';
    case 'budget_exceeded': return /^turn budget/.test(r.error ?? '') ? turnCapText(r) : budgetRefusalText(r.error);
    case 'max_steps':       return `I could not finish within ${COMPOSER_MAX_STEPS} steps.${lintFailureNote(drafts)} Say "continue" or narrow the task down.`;
    default: {
      // Spec 040 FR-003: never a bare status. What the agent last said beats a generic line.
      if (r.lastText?.trim()) return r.lastText.trim();
      const reason = r.status === 'ok' ? 'empty reply' : r.status === 'no_terminal' ? 'no final step' : (r.error ?? r.status);
      return `The agent stopped without an answer (${reason}). Try again or rephrase.`;
    }
  }
}

/** Why the last draft of the turn was not accepted, by check code (the quoted fragment is post content). */
export function lintFailureNote(drafts: readonly EditorDraft[]): string {
  const last = [...drafts].reverse().find((d) => d.lint && !d.lint.ok);
  if (!last?.lint) return '';
  const seen = new Set<string>();
  const items = last.lint.errors.flatMap((e) => {
    const quoted = /"([^"]{1,60})"/.exec(e.message)?.[1];
    const item = quoted ? `${e.code} ("${quoted}")` : e.code;
    if (seen.has(item)) return [];
    seen.add(item);
    return [item];
  });
  return items.length ? ` The draft did not pass the checks: ${items.slice(0, 5).join(', ')}.` : '';
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
    const multi = await this.addressees(text);
    if (multi) return multi;
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
    // Spec 040 FR-015: a chat bound to an agent keeps it without a mention, whatever channel the composer has picked.
    if (chatAgentId) {
      const a = await ag.get(chatAgentId);
      if (a) return { kind: 'agent', agent: a, note: null };
    }
    if (picked) return { kind: 'legacy' };
    return { kind: 'legacy' };
  }

  /**
   * Spec 047 FR-003: a message that opens with several agent mentions goes to each channel agent in turn (a role resolves
   * to its orchestrator). With @manager among them it goes to @manager, which coordinates the others.
   */
  private async addressees(text: string): Promise<Route | null> {
    const ag = this.d.agents!;
    const lead = leadingMentions(text);
    if (lead.length < 2) return null;
    const found: Agent[] = [];
    for (const h of lead) {
      let a = await ag.byHandle(h);
      if (!a) continue;
      if (a.parentId) a = (await ag.get(a.parentId)) ?? a;
      if (!found.some((x) => x.id === a!.id)) found.push(a);
    }
    const manager = found.find((a) => a.kind === 'manager');
    const channel = found.filter((a) => a.kind !== 'manager' && a.kind !== 'builder' && a.kind !== 'auditor');
    if (manager && channel.length) {
      return { kind: 'agent', agent: manager, note: `Власник звернувся одразу до ${found.map((a) => `@${a.handle}`).join(', ')}: ти координуєш — зроби або запропонуй картками те, що стосується кожного з них.` };
    }
    if (channel.length < 2 || found.some((a) => a.kind === 'builder')) return null;
    return { kind: 'agents', agents: channel.slice(0, MAX_ADDRESSEES) };
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
      const cmd = this.d.slash ? parseSlash(text) : null;
      if (cmd) return await this.runCommand(chatId, text, cmd, chat?.agentId ?? null, prior.length === 0, opts, emit);
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
        // Spec 055: @sysadmin works on a schedule (its report is the /audit artifact); it has no chat turn of its own.
        if (addressee.kind === 'auditor') {
          const message = await this.d.repo.addMessage({
            chatId, role: 'assistant', agentId: addressee.id,
            content: `@${addressee.handle} audits the network once a week and does not chat. Its report is on the Artifacts page (Audits); /audit runs one now.`,
          });
          emit({ type: 'message', message });
          return { message, drafts: [] };
        }
      }

      if (route.kind === 'agents') return await this.runAddressees(chatId, text, route.agents, prior, chatDrafts, emit, opts);
      const turn = await this.composerTurn(chatId, text, addressee, route.kind === 'agent' ? route.note : null, prior, chatDrafts, emit, opts, chatTurnCap(this.d.env));
      return { message: turn.message, drafts: turn.drafts };
    } finally {
      this.running.delete(chatId);
    }
  }

  /** Spec 048 FR-005: the turn's artifacts as chips; a lookup that fails keeps the bare reference. */
  private async chips(rec: TurnRecorder): Promise<ArtifactChip[]> {
    const out: ArtifactChip[] = [];
    for (const a of rec.artifacts.slice(0, 12)) {
      const chip = this.d.artifactChip ? await this.d.artifactChip(a.type, a.id).catch(() => undefined) : undefined;
      if (chip !== null) out.push(chip ?? { type: a.type, id: a.id, title: a.type, status: '' });
    }
    return out;
  }

  /** Spec 048 FR-003: a slash command — the owner's message and a code-made answer with its artifact chips. */
  private async runCommand(
    chatId: string, text: string, cmd: SlashCommand, chatAgentId: string | null, first: boolean, opts: SendOptions,
    emit: (e: ChatStreamEvent) => void,
  ): Promise<{ message: EditorChatMessage; drafts: EditorDraft[] }> {
    await this.d.repo.addMessage({ chatId, role: 'user', content: text });
    await this.d.repo.touchChat(chatId, first ? text.replace(/\s+/g, ' ').slice(0, TITLE_CHARS) : undefined);
    const agent = chatAgentId && this.d.agents ? await this.d.agents.get(chatAgentId) : null;
    const own = agent && agent.kind !== 'builder' && agent.kind !== 'manager' && agent.kind !== 'auditor' ? agent : null;
    const ctx: SlashContext = {
      agent: own?.handle ?? null,
      channel: (own && this.d.agents ? await this.d.agents.channelKeyOf(own) : null) ?? opts.channel ?? null,
    };
    let result: SlashResult;
    try {
      result = await runSlash(cmd, ctx, this.d.slash!);
    } catch (err: any) {
      result = { content: `/${cmd.word} failed: ${String(err?.message ?? err).slice(0, 200)}`, artifacts: [] };
    }
    const message = await this.d.repo.addMessage({ chatId, role: 'assistant', content: result.content, artifacts: result.artifacts });
    emit({ type: 'message', message });
    return { message, drafts: [] };
  }

  /**
   * The composer turn of one addressee (a channel agent) or of the plain composer: its channel, card, memory and tools;
   * the answer is stored as its own message. `maxCostUsd` is what is left of this turn's cap.
   */
  private async composerTurn(
    chatId: string, text: string, addressee: Agent | null, note: string | null, prior: EditorChatMessage[], chatDrafts: EditorDraft[],
    emit: (e: ChatStreamEvent) => void, opts: SendOptions, maxCostUsd: number | null,
  ): Promise<{ message: EditorChatMessage; drafts: EditorDraft[]; costUsd: number }> {
    const agentKey = addressee && this.d.agents ? await this.d.agents.channelKeyOf(addressee) : null;
    const channelKey = agentKey ?? await this.resolveChannel(text, opts.channel ?? null, prior, chatDrafts);
    const resolved = channelKey ? await this.d.drafts.resolveCard(channelKey) : null;
    const memory = channelKey && resolved?.hasCard ? await this.d.memory.listActive(channelKey) : [];
    const agentCtx = addressee && this.d.agents ? await this.d.agents.forAgent(addressee, 'composer') : null;
    const persona = addressee && this.d.agents
      ? agentPersona(addressee, await this.d.agents.profileOf(addressee), note ? [note] : [])
      : null;

    const touched = new Map<string, EditorDraft>();
    const actions: PendingAction[] = [];
    const rec = new TurnRecorder();
    const extras: ComposerExtras & AgentChatExtras & Record<string, unknown> = {
      chat: { chatId, channelKey },
      card: resolved?.card,
      userIntent: hasPublishIntent(text),
      // The card in extras is the draft's channel card (save_draft switches it), so the preview renders like the post.
      onDraft: (draft) => { touched.set(draft.id, draft); rec.draft(draft.id); emit({ type: 'draft', draft: renderDraft(draft, (extras.card as EditorCard | undefined) ?? null) }); },
      agentIntent: ownerChangeIntent(text, lastAssistantText(prior)),
      ownerText: text,
      ownerRecent: ownerRecent(prior, text),
      onAction: (a) => { actions.push(a); rec.card(a.id, a.kind); emit({ type: 'action', action: a }); },
      ...(agentCtx ? { agent: addressee, skills: agentCtx.skills } : {}),
    };
    const onEvent = (e: AgentLoopEvent) => {
      if (e.type === 'llm_text') emit({ type: 'text', text: e.text });
      else emit(e);
    };

    const history = await this.history(chatId, prior, chatDrafts);
    const facts = await this.chatFacts(chatId);
    const factText = facts ? factsBlock(facts) : null;
    let res: AgentLoopResult;
    try {
      res = await this.runGuarded(rec, {
        role: 'composer', channelKey: null,
        model: await (async () => {
          const { workspace, defaultModel } = await readModelContext(this.d);
          return resolveModel('composer', this.d.env, null, {
            agentModel: agentModelIn(addressee, workspace), defaultModel, reasoningEffort: addressee?.reasoningEffort, workspace,
          });
        })(),
        system: withFacts(buildComposerSystemPrompt({
          now: this.now(), card: resolved?.card ?? null, hasCard: !!resolved?.hasCard, memory, skills: agentCtx?.skills ?? this.d.skills, persona,
        }), factText),
        user: text, history, tools: await this.chatTools('composer', addressee),
        maxSteps: COMPOSER_MAX_STEPS, extras: extras as unknown as Record<string, unknown>, onEvent,
        agent: addressee ? { id: addressee.id, handle: addressee.handle, limitUsd: addressee.dailyBudgetUsd } : null,
        usage: { feature: chatFeature('composer'), shadow: false }, maxCostUsd,
      }, facts);
    } catch (err: any) {
      res = { runId: null, status: 'error', totals: { steps: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 }, error: err?.message ?? String(err) };
    }
    const ok = res.status === 'ok' && !!res.finalText?.trim();
    if (!ok) emit({ type: 'error', error: res.error ?? res.status });
    const message = await this.d.repo.addMessage({
      chatId, role: 'assistant', content: ok ? res.finalText!.trim() : failureText(res, [...touched.values()]), draftIds: [...touched.keys()], runId: res.runId,
      agentId: addressee?.id ?? null, actions: rec.turn, artifacts: await this.chips(rec),
    });
    await this.d.repo.touchChat(chatId);
    emit({ type: 'message', message });
    return { message, drafts: [...touched.values()], costUsd: res.totals.costUsd };
  }

  /**
   * Spec 047 FR-003: a message addressed to several channel agents («@ai_global @loko_games @nova_dev переплануйте…») runs
   * for each in turn — one streamed answer per agent, each stored with its author — under one shared turn cap. A later
   * agent sees the earlier answers in its history. Agents the cap leaves out are named in a final note.
   */
  private async runAddressees(
    chatId: string, text: string, agents: Agent[], prior: EditorChatMessage[], chatDrafts: EditorDraft[],
    emit: (e: ChatStreamEvent) => void, opts: SendOptions,
  ): Promise<{ message: EditorChatMessage; drafts: EditorDraft[] }> {
    const cap = chatTurnCap(this.d.env);
    const all = agents.map((x) => `@${x.handle}`).join(', ');
    emit({ type: 'addressees', agents: agents.map(agentRef) });
    let spent = 0;
    let last: { message: EditorChatMessage; drafts: EditorDraft[] } | null = null;
    const drafts: EditorDraft[] = [];
    const answers: string[] = [];
    for (const [i, a] of agents.entries()) {
      const left = cap === null ? null : cap - spent;
      if (left !== null && left < MIN_ADDRESSEE_USD) {
        const message = await this.d.repo.addMessage({
          chatId, role: 'assistant',
          content: `Stopped before ${agents.slice(i).map((x) => `@${x.handle}`).join(', ')} — this message reached the per-turn chat cap ($${cap!.toFixed(2)}, EDITOR_CHAT_TURN_MAX_USD in Settings → Configuration). Write to them again to continue.`,
        });
        emit({ type: 'message', message });
        return { message, drafts };
      }
      emit({ type: 'agent', agent: agentRef(a) });
      const note = [
        `Повідомлення власника адресоване кільком агентам: ${all}. Ти — @${a.handle}: відповідай лише за свій канал і роби свою частину; інші агенти відповідають окремо.`,
        ...(answers.length ? ['Уже відповіли в цьому ході:', ...answers] : []),
      ].join('\n');
      const r = await this.composerTurn(chatId, text, a, note, prior, chatDrafts, emit, opts, left);
      answers.push(`@${a.handle}: ${r.message.content.replace(/\s+/g, ' ').slice(0, ANSWER_NOTE_CHARS)}`);
      spent += r.costUsd;
      drafts.push(...r.drafts);
      last = { message: r.message, drafts };
    }
    if (this.d.repo.setChatAgent) await this.d.repo.setChatAgent(chatId, agents[agents.length - 1].id);
    return last!;
  }

  /**
   * A role's tools for a chat turn. Terminal tools end an autonomous run (the nightly manager's submit_review): in chat
   * the answer ends the turn, and the loop would otherwise nudge — and on the last step force — the agent to call one,
   * which records a run summary and leaves the owner with no reply.
   */
  private async chatTools(role: EditorRole, agent?: Agent | null) {
    // Spec 054: the addressed agent's loadout narrows its own tools; the chat's own (chat-only, composer) stay.
    const allow = this.d.loadout && agent ? await this.d.loadout.allowFor(agent, { role, registry: this.d.registry, chat: true }) : null;
    return this.d.registry.forRole(role, allow, { chat: true }).filter((t) => t.kind !== 'terminal');
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
      ? buildBuilderPrompt({ now: this.now(), skills: ctx.skills, agentsSummary: await ag.agentsSummary(), agent })
      : buildManagerChatPrompt({ now: this.now(), skills: ctx.skills, agent, digest: ag.managerDigest ? await ag.managerDigest() : null });
    const rec = new TurnRecorder();
    const extras: AgentChatExtras & Record<string, unknown> = {
      chat: { chatId, channelKey: null },
      agentIntent: ownerChangeIntent(text, lastAssistantText(prior)),
      ownerText: text,
      ownerRecent: ownerRecent(prior, text),
      onAction: (a) => { rec.card(a.id, a.kind); emit({ type: 'action', action: a }); },
      agent, skills: ctx.skills,
    };
    const onEvent = (e: AgentLoopEvent) => {
      if (e.type === 'llm_text') emit({ type: 'text', text: e.text });
      else emit(e);
    };
    const mctx = await readModelContext(this.d);
    let res: AgentLoopResult;
    try {
      const history = await this.history(chatId, prior, chatDrafts);
      const facts = await this.chatFacts(chatId);
      res = await this.runGuarded(rec, {
        role, channelKey: null, model: resolveModel(role, this.d.env, null, { agentModel: agentModelIn(agent, mctx.workspace), defaultModel: mctx.defaultModel, reasoningEffort: agent.reasoningEffort, workspace: mctx.workspace }),
        system: withFacts(note ? `${system}\n\n${note}` : system, facts ? factsBlock(facts) : null),
        user: text, history, tools: await this.chatTools(role, agent),
        maxSteps: COMPOSER_MAX_STEPS, extras, onEvent,
        agent: { id: agent.id, handle: agent.handle, limitUsd: agent.dailyBudgetUsd },
        usage: { feature: chatFeature(role), shadow: false }, maxCostUsd: chatTurnCap(this.d.env),
      }, facts);
    } catch (err: any) {
      res = { runId: null, status: 'error', totals: { steps: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 }, error: err?.message ?? String(err) };
    }
    const ok = res.status === 'ok' && !!res.finalText?.trim();
    if (!ok) emit({ type: 'error', error: res.error ?? res.status });
    const message = await this.d.repo.addMessage({
      chatId, role: 'assistant', content: ok ? res.finalText!.trim() : failureText(res), runId: res.runId, agentId: agent.id, actions: rec.turn,
      artifacts: await this.chips(rec),
    });
    await this.d.repo.touchChat(chatId);
    emit({ type: 'message', message });
    return { message, drafts: [] };
  }

  /**
   * Prior text turns. An assistant turn carries its author (`@handle:`), a summary of the drafts it touched (ids for
   * later edits) and (spec 040 FR-014) what its tools did, with the cards' statuses as they are now.
   */
  private async history(chatId: string, prior: EditorChatMessage[], drafts: EditorDraft[]): Promise<ChatMessage[]> {
    const byId = new Map(drafts.map((x) => [x.id, x]));
    const cards = prior.some((m) => m.actions?.cards.length) && this.d.agents
      ? new Map((await this.d.agents.actionsForChat(chatId).catch(() => [] as PendingAction[])).map((a) => [a.id, a.status]))
      : new Map<string, string>();
    const handles = new Map<string, string>();
    if (this.d.agents) {
      for (const id of new Set(prior.filter((m) => m.role === 'assistant' && m.agentId).map((m) => m.agentId!))) {
        const a = await this.d.agents.get(id).catch(() => null);
        if (a) handles.set(id, a.handle);
      }
    }
    return prior.map((m) => {
      if (m.role === 'user') return { role: 'user', content: m.content };
      const lines = m.draftIds.map((id) => byId.get(id)).filter((x): x is EditorDraft => !!x).map(draftLine);
      const content = lines.length ? `${m.content}\n\n[чернетки: ${lines.join('; ')}]` : m.content;
      return { role: 'assistant', content: historyTurn(content, m.agentId ? handles.get(m.agentId) ?? null : null, actionLine(m.actions, (id) => cards.get(id))) };
    });
  }

  /**
   * Spec 040 FR-014: one run with the turn's tools recorded; a reply claiming an action no tool did gets one re-prompt
   * (its tool calls count too), and a reply that still claims it ends with a visible note. Spec 047 FR-002: a reply that
   * denies what the chat facts show (an applied card, a real agent, a tool this turn called) is re-prompted the same way.
   */
  private async runGuarded(rec: TurnRecorder, input: AgentLoopInput, facts: ChatFacts | null = null): Promise<AgentLoopResult> {
    const run = { ...input, tools: rec.wrap(input.tools) };
    const first = await this.d.loop.run(run);
    if (first.status !== 'ok' || !first.finalText?.trim()) return first;
    const denialsOf = (t: string) => (facts ? contradictedDenials(t, facts, rec.turn) : []);
    const claimsOf = (t: string) => unbackedClaims(t, rec.turn).filter((c) => !restatesFact(c.sentence, facts));
    const claims = claimsOf(first.finalText);
    const denials = denialsOf(first.finalText);
    if (!claims.length && !denials.length) return first;
    let second: AgentLoopResult | null = null;
    try {
      second = await this.d.loop.run({
        ...run, history: [...(input.history ?? []), { role: 'user', content: input.user }, { role: 'assistant', content: first.finalText.trim() }],
        user: [claims.length ? claimRePrompt(claims) : null, denials.length ? denialRePrompt(denials) : null].filter(Boolean).join('\n\n'),
      });
    } catch { /* the first reply stands, with the note */ }
    const res = second?.status === 'ok' && second.finalText?.trim() ? second : first;
    const final = res.finalText!.trim();
    const notes = [
      claimsOf(final).length ? NOT_DONE_NOTE : null,
      (() => { const left = denialsOf(final); return left.length ? denialNote(left) : null; })(),
    ].filter(Boolean);
    return notes.length ? { ...res, finalText: `${final}\n\n${notes.join('\n')}` } : res;
  }

  /** Spec 047 FR-002: the chat's cards with their statuses now, and the agent roster. Null without the agent platform. */
  private async chatFacts(chatId: string): Promise<ChatFacts | null> {
    const ag = this.d.agents;
    if (!ag) return null;
    const [cards, handles] = await Promise.all([
      ag.actionsForChat(chatId).catch(() => [] as PendingAction[]),
      ag.handles().catch(() => [] as string[]),
    ]);
    const sorted = [...cards].sort((a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime());
    return { cards: sorted, handles: handles.map((h) => h.replace(/^@/, '').toLowerCase()) };
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
