import { z } from 'zod';
import { defineTool, EditorTool, ToolContext } from '../harness/tool';
import { parseResourceRef, validateHandle } from './agent.types';
import type { AgentsRepository } from './agents.repository';
import type { AgentCreator } from './agent-creator';
import type { PendingAction, PendingActionsService } from './pending-actions';
import type { ResourceCatalog } from './resource-catalog';
import { KPI_GOALS, ResourceProfile, ResourceProfileSchema, ResourceProfilesRepository } from './resource-profile';
import { lintSkill, SKILL_ROLES } from './skill-lint';
import type { SkillStore } from './skill-store';

/** Per-run state of an agent chat turn (spec 018), put into ctx.extras by the chat service. */
export interface AgentChatExtras {
  chat:        { chatId: string | null; channelKey: string | null };
  /** The owner's latest message explicitly asks to change agents (hasAgentChangeIntent). */
  agentIntent: boolean;
  /** The owner's latest message (add_owner_rule checks the rule paraphrases it). */
  ownerText:   string;
  onAction?:   (a: PendingAction) => void;
}

export interface BuilderToolDeps {
  agents:   Pick<AgentsRepository, 'list' | 'getByHandle' | 'handleTaken'>;
  catalog:  Pick<ResourceCatalog, 'list' | 'inspect'>;
  profiles: Pick<ResourceProfilesRepository, 'get'>;
  creator:  Pick<AgentCreator, 'validate'>;
  skills:   Pick<SkillStore, 'findShared'>;
  actions:  Pick<PendingActionsService, 'propose'>;
}

export const NEEDS_CHANGE_REQUEST = {
  error: 'needs_explicit_request',
  details: 'власник не просив цю зміну в останньому повідомленні — опиши, що пропонуєш, і запитай підтвердження',
};

export function chatExtras(ctx: ToolContext): AgentChatExtras {
  const x = ctx.extras as AgentChatExtras | undefined;
  if (!x?.chat) throw new Error('agent chat tools run only inside a chat');
  return x;
}

/** Propose a confirmation card (pending action) and stream it to the UI. */
export async function proposeCard(
  d: Pick<BuilderToolDeps, 'actions'>, ctx: ToolContext, kind: string, payload: Record<string, unknown>, summary: string, agentId?: string | null,
) {
  const x = chatExtras(ctx);
  if (!x.agentIntent) return NEEDS_CHANGE_REQUEST;
  const action = await d.actions.propose({ chatId: x.chat.chatId, agentId: agentId ?? null, kind, payload, summary });
  try { x.onAction?.(action); } catch { /* UI stream only */ }
  return { ok: true, pending_action: action.id, summary, note: 'Власник побачить картку з кнопками Apply / Discard — дія виконається лише після його кліку.' };
}

const AgentPatchInput = z.object({
  name:             z.string().trim().min(1).max(60).optional(),
  handle:           z.string().trim().max(40).optional(),
  emoji:            z.string().trim().max(8).optional(),
  description:      z.string().trim().max(500).optional(),
  // No `mode`: only the owner switches a mode, in the dashboard (spec 031 FR-010).
  status:           z.enum(['active', 'paused']).optional(),
  paused_until:     z.string().max(40).nullable().optional().describe('ISO з часовим поясом; null — зняти паузу'),
  model:            z.string().trim().max(100).nullable().optional(),
  schedule:         z.object({ times: z.array(z.string()).max(8) }).optional(),
  daily_budget_usd: z.number().min(0).max(50).nullable().optional(),
}).strict();

/** Tools of the @ai0 builder (spec 018 FR-004). Mutations only propose cards. */
export function buildBuilderTools(d: BuilderToolDeps): EditorTool[] {
  const listResources = defineTool({
    name: 'list_resources',
    description: 'Усі підключені ресурси (Telegram-канали, Instagram, Facebook, Threads, TikTok, YouTube): ref, назва, підписники, мережа і агент, який його веде (null — вільний).',
    kind: 'read', roles: ['builder'],
    input: z.object({}),
    execute: async () => ({ resources: await d.catalog.list() }),
  });

  const inspectResource = defineTool({
    name: 'inspect_resource',
    description: 'Огляд ресурсу перед створенням агента: опис, теми, статистика за 28 днів, останні пости, перевірка доступу (бот адмін / токен дійсний), чи є профіль.',
    kind: 'read', roles: ['builder'],
    input: z.object({ ref: z.string().min(3).max(200).describe('<platform>:<id>, напр. telegram:@my_channel') }),
    execute: async ({ ref }) => d.catalog.inspect(ref.trim()),
  });

  const draftProfile = defineTool({
    name: 'draft_resource_profile',
    description: 'Чернетка профілю ресурсу з його історії (тема, частота) + список полів, яких бракує. Доповни з відповідей власника, нічого не вигадуючи.',
    kind: 'read', roles: ['builder'],
    input: z.object({ ref: z.string().min(3).max(200) }),
    execute: async ({ ref }) => {
      const i = await d.catalog.inspect(ref.trim());
      if ('error' in i) return i;
      const existing = await d.profiles.get(ref.trim());
      if (existing?.profile) return { draft: existing.profile, missing: [], note: 'профіль уже існує — показую його' };
      const title = i.resource.title ?? i.resource.username ?? ref;
      const draft: Partial<ResourceProfile> = {
        topic: i.about?.trim() ? i.about.trim().slice(0, 300) : `${title}${i.themes.length ? ` — ${i.themes.slice(0, 5).join(', ')}` : ''}`,
        language: 'uk',
        goals: ['growth', 'engagement'],
        taboo: [], sources: [], examples: [],
        frequency_hint: i.stats.postsPerDay ? `зараз ~${i.stats.postsPerDay} постів/день` : undefined,
        ads_allowed: { allowed: true, categories: [] },
      };
      const missing = ['audience.who', 'goals (підтвердити пріоритет: ' + KPI_GOALS.join(', ') + ')', 'tone', 'taboo'];
      return { draft, missing, recent_posts: i.recentPosts.slice(0, 8), stats: i.stats, access: i.access };
    },
  });

  const listAgents = defineTool({
    name: 'list_agents',
    description: 'Усі агенти: @handle, імʼя, тип, ресурс чи мережа, режим (off/shadow/approve/live), пауза.',
    kind: 'read', roles: ['builder', 'manager', 'composer'],
    input: z.object({}),
    execute: async () => ({
      agents: (await d.agents.list()).filter((a) => !a.parentId).map((a) => ({
        handle: a.handle, name: a.name, emoji: a.emoji, kind: a.kind, scope: a.scope, scope_id: a.scopeId, mode: a.mode,
        status: a.status, paused_until: a.pausedUntil, daily_budget_usd: a.dailyBudgetUsd,
      })),
    }),
  });

  const getAgent = defineTool({
    name: 'get_agent',
    description: 'Картка агента: налаштування, профіль ресурсу, підлеглі ролі.',
    kind: 'read', roles: ['builder', 'manager'],
    input: z.object({ handle: z.string().min(2).max(40) }),
    execute: async ({ handle }) => {
      const a = await d.agents.getByHandle(handle);
      if (!a) return { error: 'unknown_agent', details: handle };
      const profile = a.scopeId ? await d.profiles.get(a.scope === 'network' ? `network:${a.scopeId}` : a.scopeId) : null;
      return { agent: a, profile: profile?.profile ?? null, health: profile?.health ?? null };
    },
  });

  const createAgent = defineTool({
    name: 'create_agent',
    description: [
      'Запропонувати створення агента для ресурсу (resource_ref) або мережі (network_id). Обовʼязковий профіль ресурсу (topic, audience.who, goals).',
      'Агент стартує в режимі апруву: пише справжні пости, але кожен чекає схвалення власника. Повертає картку для підтвердження — створення відбудеться лише після кліку власника.',
    ].join(' '),
    kind: 'act', roles: ['builder'],
    input: z.object({
      resource_ref:     z.string().min(3).max(200).optional(),
      network_id:       z.string().uuid().optional(),
      name:             z.string().min(1).max(60),
      handle:           z.string().min(3).max(40),
      emoji:            z.string().max(8).optional(),
      description:      z.string().max(500).optional(),
      profile:          ResourceProfileSchema,
      brief:            z.string().max(4000).optional(),
      schedule:         z.object({ times: z.array(z.string()).max(8) }).optional(),
      daily_budget_usd: z.number().min(0).max(50).optional(),
    }),
    execute: async (i, ctx) => {
      const v = await d.creator.validate(i);
      if ('error' in v) return v;
      const target = i.resource_ref ?? `network:${i.network_id}`;
      return proposeCard(d, ctx, 'create_agent', i as unknown as Record<string, unknown>,
        `Створити агента ${i.emoji ?? '📣'} ${i.name} (@${v.input.handle}) для ${target} — старт у режимі апруву (кожен пост чекає вашого схвалення). Тема: ${i.profile.topic}`);
    },
  });

  const updateAgent = defineTool({
    name: 'update_agent',
    description: 'Запропонувати зміну агента: імʼя, handle, емодзі, опис, пауза (status або paused_until), модель, розклад, бюджет. Режим (off/shadow/approve/live) змінює лише власник у дашборді.',
    kind: 'act', roles: ['builder'],
    input: z.object({ handle: z.string().min(2).max(40), patch: AgentPatchInput }),
    execute: async ({ handle, patch }, ctx) => {
      const a = await d.agents.getByHandle(handle);
      if (!a) return { error: 'unknown_agent', details: handle };
      if (patch.handle) {
        const h = patch.handle.replace(/^@/, '').toLowerCase();
        const err = validateHandle(h);
        if (err) return { error: 'invalid_handle', details: err };
        if (await d.agents.handleTaken(h, a.id)) return { error: 'handle_taken', details: `@${h}` };
        patch.handle = h;
      }
      if (patch.paused_until && Number.isNaN(new Date(patch.paused_until).getTime())) return { error: 'invalid_paused_until' };
      const parts = Object.entries(patch).map(([k, v]) => `${k} → ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
      if (!parts.length) return { error: 'empty_patch' };
      return proposeCard(d, ctx, 'update_agent', { handle: a.handle, patch }, `Змінити @${a.handle}: ${parts.join('; ')}`, a.id);
    },
  });

  const setBrief = defineTool({
    name: 'set_brief',
    description: 'Запропонувати новий бриф агента (вільний текст: що й куди публікувати). Після підтвердження оркестратор перебудує плейбук.',
    kind: 'act', roles: ['builder'],
    input: z.object({ handle: z.string().min(2).max(40), brief: z.string().min(10).max(4000) }),
    execute: async ({ handle, brief }, ctx) => {
      const a = await d.agents.getByHandle(handle);
      if (!a) return { error: 'unknown_agent', details: handle };
      return proposeCard(d, ctx, 'set_brief', { handle: a.handle, brief }, `Новий бриф для @${a.handle}: ${brief.slice(0, 300)}${brief.length > 300 ? '…' : ''}`, a.id);
    },
  });

  const setProfile = defineTool({
    name: 'set_resource_profile',
    description: 'Запропонувати оновлення профілю ресурсу (тема, аудиторія, цілі, тон, табу, джерела…).',
    kind: 'act', roles: ['builder'],
    input: z.object({ ref: z.string().min(3).max(200), profile: ResourceProfileSchema }),
    execute: async ({ ref, profile }, ctx) => {
      if (!parseResourceRef(ref) && !ref.startsWith('network:')) return { error: 'invalid_ref' };
      return proposeCard(d, ctx, 'set_resource_profile', { ref, profile }, `Оновити профіль ${ref}: ${profile.topic}`);
    },
  });

  const writeSkill = defineTool({
    name: 'write_skill',
    description: 'Запропонувати новий скіл агента або зміну існуючого (повний текст markdown). Перевіряється лінтером; застосовується після підтвердження власника.',
    kind: 'act', roles: ['builder'],
    input: z.object({
      handle:      z.string().min(2).max(40),
      name:        z.string().min(3).max(48),
      description: z.string().min(10).max(300),
      applies_to:  z.array(z.enum(SKILL_ROLES as unknown as [string, ...string[]])).min(1),
      body:        z.string().min(20).max(12_000),
      inline:      z.boolean().optional(),
    }),
    execute: async (i, ctx) => {
      const a = await d.agents.getByHandle(i.handle);
      if (!a) return { error: 'unknown_agent', details: i.handle };
      const lint = lintSkill({ name: i.name, description: i.description, appliesTo: i.applies_to, body: i.body, inline: i.inline });
      if (!lint.ok) return { error: 'skill_lint_failed', details: lint.errors };
      const shared = await d.skills.findShared(i.name);
      if (shared?.safety) return { error: 'safety_skill', details: 'системний скіл безпеки змінюється лише на сторінці агента з підтвердженням' };
      return proposeCard(d, ctx, 'write_skill', { ...i, handle: a.handle },
        `${shared ? 'Перевизначити' : 'Додати'} скіл «${i.name}» для @${a.handle}${i.inline ? ' (завжди в контексті)' : ''}: ${i.description}`, a.id);
    },
  });

  const toggleSkill = (name: 'attach_skill' | 'detach_skill') => defineTool({
    name,
    description: name === 'attach_skill'
      ? 'Запропонувати увімкнути агенту наявний скіл (опційно — завжди в контексті).'
      : 'Запропонувати вимкнути агенту скіл.',
    kind: 'act', roles: ['builder'],
    input: z.object({ handle: z.string().min(2).max(40), skill: z.string().min(3).max(48), inline: z.boolean().optional() }),
    execute: async ({ handle, skill, inline }, ctx) => {
      const a = await d.agents.getByHandle(handle);
      if (!a) return { error: 'unknown_agent', details: handle };
      return proposeCard(d, ctx, name, { handle: a.handle, skill, inline },
        `${name === 'attach_skill' ? 'Увімкнути' : 'Вимкнути'} скіл «${skill}» для @${a.handle}${inline ? ' (завжди в контексті)' : ''}`, a.id);
    },
  });

  return [listResources, inspectResource, draftProfile, listAgents, getAgent, createAgent, updateAgent, setBrief, setProfile, writeSkill, toggleSkill('attach_skill'), toggleSkill('detach_skill')];
}
