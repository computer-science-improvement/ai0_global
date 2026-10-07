import type { Pool } from 'pg';
import { AgentLoop } from '../../src/editor/harness/agent-loop';
import { ToolRegistry } from '../../src/editor/harness/tool-registry';
import { PgRunRecorder } from '../../src/editor/harness/run-recorder';
import { BudgetService } from '../../src/editor/harness/budget.service';
import { OpenRouterClient } from '../../src/editor/llm/openrouter.client';
import type { LlmClient, LlmRequest, LlmResponse } from '../../src/editor/llm/llm.types';
import { ReadonlyQueryService } from '../../src/editor/db/readonly-query.service';
import { SkillLibrary } from '../../src/editor/skills/skill-library';
import { buildReadTools } from '../../src/editor/tools/read-tools';
import { buildDataTools } from '../../src/editor/tools/data-tools';
import { buildComposeTools } from '../../src/editor/tools/compose-tools';
import { buildRoleTools } from '../../src/editor/tools/role-tools';
import { EditorChannelsRepository } from '../../src/editor/repo/editor-channels.repository';
import { EditorPlansRepository } from '../../src/editor/repo/editor-plans.repository';
import { EditorMemoryRepository } from '../../src/editor/repo/editor-memory.repository';
import { EditorRunnerService } from '../../src/editor/roles/editor-runner.service';
import type { TgMessage } from '../../src/editor/post/render-telegram';
import { EditorChatRepository } from '../../src/editor/repo/editor-chat.repository';
import { DraftsService } from '../../src/editor/chat/drafts.service';
import { buildComposerTools } from '../../src/editor/chat/composer-tools';
import { EditorChatService } from '../../src/editor/chat/editor-chat.service';
import type { FakeWeb } from './fake-web';
import { AgentsRepository } from '../../src/editor/agents/agents.repository';
import { AgentRegistrySync } from '../../src/editor/agents/agent-registry-sync';
import { AgentRuntime } from '../../src/editor/agents/agent-runtime';
import { SkillStore } from '../../src/editor/agents/skill-store';
import { OwnerInbox } from '../../src/editor/agents/owner-inbox';
import { ResourceProfilesRepository } from '../../src/editor/agents/resource-profile';
import { ResourceCatalog } from '../../src/editor/agents/resource-catalog';
import { PendingActionsRepository, PendingActionsService } from '../../src/editor/agents/pending-actions';
import { AgentCreator } from '../../src/editor/agents/agent-creator';
import { buildBuilderTools } from '../../src/editor/agents/builder-tools';
import { buildAgentChatTools } from '../../src/editor/agents/agent-chat-tools';
import { ScheduleService } from '../../src/editor/schedule/schedule.service';
import { ScheduleRepository } from '../../src/editor/schedule/schedule.repository';
import { buildScheduleTools, registerScheduleActions } from '../../src/editor/schedule/schedule-tools';
import { TelegramScopeKpi } from '../../src/editor/agents/scope-kpi';
import { buildAgentSkillTools } from '../../src/editor/agents/agent-skill-tools';
import { telegramKeyOf } from '../../src/editor/agents/agent.types';
import type { AgentChatPort } from '../../src/editor/chat/editor-chat.service';
import { NetworkRepository } from '../../src/editor/network/network.repository';
import { NetworkRunner } from '../../src/editor/network/network-runner';
import { DerivedSlots } from '../../src/editor/network/derived-slots';
import { renderFormatPrefs } from '../../src/editor/agents/resource-profile';
import { buildNetworkTools } from '../../src/editor/network/network-tools';
import { DirectivesRepository } from '../../src/editor/manager/directives.repository';
import { KpiDigestService } from '../../src/editor/manager/kpi-digest.service';
import { ManagerRunner } from '../../src/editor/manager/manager-runner';
import { buildDirectiveTools } from '../../src/editor/manager/directive-tools';
import { PlatformPostsRepository } from '../../src/editor/platform/platform-posts.repository';
import { buildPlatformTools } from '../../src/editor/platform/platform-tools';

/** Counts LLM calls/cost of the agent under test (separately from the judge). */
class CountingLlm implements LlmClient {
  calls = 0;
  costUsd = 0;
  constructor(private readonly inner: LlmClient) {}
  async chat(req: LlmRequest): Promise<LlmResponse> {
    this.calls++;
    const res = await this.inner.chat(req);
    this.costUsd += res.usage.costUsd;
    return res;
  }
}

export interface EvalStack {
  pool:     Pool;
  channels: EditorChannelsRepository;
  plans:    EditorPlansRepository;
  memory:   EditorMemoryRepository;
  runner:   EditorRunnerService;
  /** Editor chat (spec 010): the same service the REST controller uses. */
  chat:     EditorChatService;
  chatRepo: EditorChatRepository;
  drafts:   DraftsService;
  llm:      CountingLlm;
  sent:     Array<{ channelKey: string; messages: TgMessage[] }>;
  previews: string[];
  notes:    string[];
  /** Agent platform (specs 017–022): the same services the module wires, with fake publishers. */
  agents:   AgentsRepository;
  registrySync: AgentRegistrySync;
  actions:  PendingActionsService;
  network:  NetworkRunner;
  networkRepo: NetworkRepository;
  manager:  ManagerRunner;
  directives: DirectivesRepository;
  platformPosts: PlatformPostsRepository;
  profiles: ResourceProfilesRepository;
  /** Spec 023 T4/T5: owner schedule rules, pins, chat cards. */
  schedule: ScheduleService;
}

/**
 * The production editor wiring (same tools, prompts, guards, loop, budget,
 * trace) with three substitutions: the web is FakeWeb, Telegram is a recorder,
 * and the clock is fixed. The LLM is REAL (OpenRouter).
 */
export function buildStack(o: { pool: Pool; web: FakeWeb; now: () => Date; apiKey: string; env: (k: string) => string | undefined }): EvalStack {
  const { pool, web, now } = o;
  const channels = new EditorChannelsRepository(pool);
  const plans = new EditorPlansRepository(pool);
  const memory = new EditorMemoryRepository(pool);
  const skills = new SkillLibrary();
  const sent: EvalStack['sent'] = [];
  const previews: string[] = [];
  const notes: string[] = [];
  let msgId = 50_000;

  const publisher = {
    send: async (channelKey: string, messages: TgMessage[]) => { sent.push({ channelKey, messages }); return { messageIds: messages.map(() => msgId++) }; },
  };
  const chatRepo = new EditorChatRepository(pool);
  const drafts = new DraftsService({
    pool, repo: chatRepo, channels, plans, publisher, recordPublish: () => {}, isPaused: () => false,
    notify: async (t) => { notes.push(t); }, now,
  });
  const agents = new AgentsRepository(pool);
  const skillStore = new SkillStore(pool);
  const inbox = new OwnerInbox(pool, async (t) => { notes.push(t); });
  const profiles = new ResourceProfilesRepository(pool);
  const registrySync = new AgentRegistrySync({ agents, channels });
  const catalog = new ResourceCatalog({ pool, telegramAccess: async () => ({ state: 'ok', detail: 'eval' }) });
  const actionsRepo = new PendingActionsRepository(pool);
  const actions = new PendingActionsService(actionsRepo, now);
  const creator = new AgentCreator({ agents, registry: registrySync, catalog, profiles, channels, now });
  // Cards are only proposed in evals; the kinds must be known (the module registers the real handlers).
  actions.register('create_agent', async (p) => creator.create(p));
  for (const k of ['update_agent', 'set_brief', 'set_resource_profile', 'write_skill', 'attach_skill', 'detach_skill', 'file_directive', 'edit_data_schema']) {
    actions.register(k, async () => { throw new Error('not applied in evals'); });
  }
  const networkRepo = new NetworkRepository(pool);
  const directives = new DirectivesRepository(pool);
  const digest = new KpiDigestService({ pool, catalog, globalCapUsd: 50, now });
  const platformPosts = new PlatformPostsRepository(pool);
  const channelKeyOf = async (a: any) => telegramKeyOf(a.parentId ? (await agents.get(a.parentId)) ?? a : a);
  const schedule = new ScheduleService({
    pool, rules: new ScheduleRepository(pool), network: networkRepo, agents, card: (k) => channels.get(k), plans, inbox, now,
  });
  // The schedule cards are real here: evals check the proposal, and Apply only runs when a case applies it.
  registerScheduleActions(actions, schedule);
  const registry = new ToolRegistry([
    ...buildBuilderTools({ agents, catalog, profiles, creator, skills: skillStore, actions }),
    ...buildAgentChatTools({ pool, memory, skills: skillStore, actions, now }),
    ...buildAgentSkillTools({ agents, skills: skillStore, kpi: new TelegramScopeKpi(pool), inbox, now }),
    ...buildNetworkTools({ repo: networkRepo, plans, memory, inbox, now, schedule }),
    ...buildScheduleTools({ schedule, actions, now }),
    ...buildDirectiveTools({ repo: directives, agents, digest, inbox, memory, actions, channelKeyOf, now }),
    ...buildPlatformTools({
      pool, plans,
      publish: { posts: platformPosts, publisher: { publish: async () => { throw new Error('evals never publish to platforms'); } }, health: async () => null, now },
      notifyPreview: async (_r, text) => { previews.push(text); },
    }),
    ...buildReadTools({ pool, readonly: new ReadonlyQueryService(pool), skills, http: web.http }),
    ...buildDataTools({ pool, actions }),
    ...buildComposeTools({ http: web.http }),
    ...buildRoleTools({
      pool, plans, memory, channels, now, publisher, schedule,
      recordPublish: () => {},
      notifyPreview: async (_k, html) => { previews.push(html); },
    }),
    ...buildComposerTools({ drafts, repo: chatRepo }),
  ]);

  const llm = new CountingLlm(new OpenRouterClient({ apiKey: o.apiKey, baseUrl: o.env('OPENROUTER_BASE_URL') }));
  const loop = new AgentLoop({
    llm,
    recorder: new PgRunRecorder(pool, (m) => notes.push(m)),
    budget: new BudgetService(pool, { globalDailyUsd: 50, channelDailyUsd: 50 }),
    enabled: () => true,
  });
  const runtime = new AgentRuntime({ agents, store: skillStore, fallback: skills, now });
  const manager = new ManagerRunner({ loop, registry, runtime, agents, repo: directives, digest, inbox, env: o.env, now });
  const network = new NetworkRunner({
    loop, registry, runtime, memory, repo: networkRepo, plans, profiles, env: o.env, now,
    catalogSummary: (card) => schedule.plannerBlock(card),
    notify: async (t) => { notes.push(t); },
    directives: (orch) => manager.deliver(orch),
    afterOrchestration: (orch) => manager.afterOrchestration(orch),
  });
  const runner = new EditorRunnerService({
    loop, registry, skills, plans, memory, now, runtime, network,
    platformContext: (slot, orchId) => network.platformContext(slot, orchId),
    catalogSummary: (card) => schedule.plannerBlock(card),
    seriesContext: (slot) => schedule.executorContext(slot),
    onSlotDone: async (slot) => { if (slot.ideaId) await networkRepo.settleIdea(slot.ideaId); },
    // Spec 024: duplicate / adapt slots, formatted by the agent from the target's format_prefs.
    derived: {
      resolve: (slot) => new DerivedSlots({ pool }).resolve(slot),
      formatPrefs: async (ref) => { const f = await profiles.formatOf(ref); return renderFormatPrefs(f.prefs, f.locks); },
    },
    env: o.env,
    notify: async (t) => { notes.push(t); },
  });
  const port: AgentChatPort = {
    byHandle: (h) => agents.getByHandle(h),
    get: (id) => agents.get(id),
    forAgent: (a, role) => runtime.forAgent(a, role),
    profileOf: async (a) => (a.scopeId ? (await profiles.get(a.scopeId))?.profile ?? null : null),
    channelKeyOf,
    agentsSummary: async () => (await agents.list()).filter((a) => !a.parentId).map((a) => `- @${a.handle} ${a.name} · ${a.kind} · ${a.scopeId ?? a.scope} · ${a.mode}`).join('\n'),
    handles: async () => (await agents.list()).filter((a) => !a.parentId).map((a) => a.handle),
    actionsForChat: (chatId) => actionsRepo.listForChat(chatId),
    managerDigest: async () => digest.render(await digest.build()),
  };
  const chat = new EditorChatService({
    repo: chatRepo, drafts, memory, loop, registry, skills, env: o.env, enabled: () => true, now, agents: port,
  });
  return {
    pool, channels, plans, memory, runner, chat, chatRepo, drafts, llm, sent, previews, notes,
    agents, registrySync, actions, network, networkRepo, manager, directives, platformPosts, profiles, schedule,
  };
}
