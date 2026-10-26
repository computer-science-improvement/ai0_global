import { z } from 'zod';
import type { ConfigConflictsService } from '../rules/config-conflicts.service';
import { defineTool, EditorTool, ToolContext } from '../harness/tool';
import { parseResourceRef, validateHandle, type Agent } from './agent.types';
import type { AgentsRepository } from './agents.repository';
import { FittingFormatSchema, type AgentCreator } from './agent-creator';
import { MAX_FITTING_FORMATS } from '../network/playbook';
import type { PendingAction, PendingActionsService } from './pending-actions';
import type { ResourceCatalog } from './resource-catalog';
import { KPI_GOALS, ResourceProfile, ResourceProfileSchema, ResourceProfilesRepository } from './resource-profile';
import { isProtectedSkill } from '../skills/skill-library';
import { lintSkill, SKILL_ROLES } from './skill-lint';
import { sourceRefusal } from './skill-warnings';
import type { SkillStore } from './skill-store';
import { defaultAppliesTo } from '../skills/skill-defaults';
import { SCRIPT_MIN_SHARE, scriptShares } from '../post/channel-language';

/** Per-run state of an agent chat turn (spec 018), put into ctx.extras by the chat service. */
export interface AgentChatExtras {
  chat:        { chatId: string | null; channelKey: string | null };
  /**
   * The owner asked for a change in this turn (ownerChangeIntent). Gates direct writes and paid runs only; card proposals
   * are not gated (spec 047 FR-001).
   */
  agentIntent: boolean;
  /** The owner's latest message (add_owner_rule checks the rule paraphrases it). */
  ownerText:   string;
  /** Spec 040 FR-010: the owner's last messages in this chat, oldest first, the latest included. */
  ownerRecent?: string[];
  onAction?:   (a: PendingAction) => void;
}

export interface BuilderToolDeps {
  agents:   Pick<AgentsRepository, 'list' | 'getByHandle' | 'handleTaken'> & Partial<Pick<AgentsRepository, 'get'>>;
  catalog:  Pick<ResourceCatalog, 'list' | 'inspect'>;
  profiles: Pick<ResourceProfilesRepository, 'get'>;
  creator:  Pick<AgentCreator, 'validate'>;
  skills:   Pick<SkillStore, 'findShared'> & Partial<Pick<SkillStore, 'findForAgent'>>;
  actions:  Pick<PendingActionsService, 'propose'>;
  /** Spec 040 FR-011 / 047 FR-005: what keeps an orchestrator's config from its owner's rules (fix_config_conflicts). */
  conflicts?: Pick<ConfigConflictsService, 'resolverFor'>;
}

/** Spec 040 FR-011: the owner card that aligns a playbook and profiles with the owner's rules. */
export const FIX_CONFIG_CONFLICTS_KIND = 'fix_config_conflicts';

/** The card's summary line (the tool and the spec 062 `/align` command write the same one). */
export function fixConflictsSummary(handle: string, items: ReadonlyArray<{ kind: string }>): string {
  const n = items.length;
  return `Align @${handle} with the owner's rules: ${n} item${n > 1 ? 's' : ''} (${[...new Set(items.map((i) => i.kind.replace('_', ' ')))].join(', ')})`;
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

/**
 * Propose a confirmation card (pending action) and stream it to the UI. Spec 047 FR-001: not gated by the owner's wording —
 * the Apply click is the confirmation, and a card the owner did not want is one Discard away. Tools that write directly or
 * start a paid run keep the `agentIntent` gate.
 */
export async function proposeCard(
  d: Pick<BuilderToolDeps, 'actions'>, ctx: ToolContext, kind: string, payload: Record<string, unknown>, summary: string, agentId?: string | null,
) {
  const x = chatExtras(ctx);
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
  grammatical_gender: z.enum(['masculine', 'feminine']).nullable().optional().describe('Рід, яким агент говорить про себе: я зробив / я зробила'),
}).strict();

/** `uk` when the resource's recent posts are Ukrainian-script prose; null when the owner has to name the language. */
function guessLanguage(texts: string[]): string | null {
  const shares = scriptShares(texts.join('\n'));
  return !shares || shares.cyrillic >= SCRIPT_MIN_SHARE ? 'uk' : null;
}

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
      const language = guessLanguage(i.recentPosts.map((x) => x.text));
      const draft: Partial<ResourceProfile> = {
        topic: i.about?.trim() ? i.about.trim().slice(0, 300) : `${title}${i.themes.length ? ` — ${i.themes.slice(0, 5).join(', ')}` : ''}`,
        language: language ?? 'uk',
        goals: ['growth', 'engagement'],
        taboo: [], sources: [], examples: [],
        frequency_hint: i.stats.postsPerDay ? `зараз ~${i.stats.postsPerDay} постів/день` : undefined,
        ads_allowed: { allowed: true, categories: [] },
      };
      const missing = [...(language ? [] : ['language (мова постів для читачів: uk, en, pl… або mixed — пости не українською кирилицею)']), 'audience.who', 'goals (підтвердити пріоритет: ' + KPI_GOALS.join(', ') + ')', 'tone', 'taboo (теми, про які ресурс не пише — не окремі слова)', 'formats (1–4, що пасують темі, з причиною кожного)'];
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
      'Бриф одразу запускає побудову плейбука. formats — 1–4 формати, що пасують темі й аудиторії, кожен з причиною (без них — text і photo); poll/quiz лише для вікторинного чи освітнього ресурсу або на прохання власника.',
      'profile.taboo — теми, про які ресурс не пише; banned_terms — лише слова, які власник прямо назвав забороненими.',
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
      formats:          z.array(FittingFormatSchema).min(1).max(MAX_FITTING_FORMATS).optional()
        .describe('1–4 формати, що пасують ресурсу: { format, reason } — чому саме цей формат цій аудиторії'),
      banned_terms:     z.array(z.string().trim().min(1).max(80)).max(50).optional()
        .describe('Лише слова, які власник прямо назвав забороненими (lint). Табу-теми — у profile.taboo'),
      daily_budget_usd: z.number().min(0).max(50).optional(),
    }),
    execute: async (i, ctx) => {
      const v = await d.creator.validate(i);
      if ('error' in v) return v;
      const target = i.resource_ref ?? `network:${i.network_id}`;
      const fmts = i.formats?.length ? i.formats.map((f) => f.format).join(', ') : 'text, photo';
      const r = await proposeCard(d, ctx, 'create_agent', i as unknown as Record<string, unknown>,
        `Create agent ${i.emoji ?? '📣'} ${i.name} (@${v.input.handle}) for ${target} — it starts in approval mode (every post waits for your approval). Topic: ${i.profile.topic}. Formats: ${fmts}.`);
      return 'ok' in r ? { ...r, next: `Далі в цій самій відповіді виклич propose_content_examples (handle ${v.input.handle}, resource_ref ${target}): 3 приклади постів і 2–4 застереження.` } : r;
    },
  });

  const updateAgent = defineTool({
    name: 'update_agent',
    description: 'Запропонувати зміну агента: імʼя, handle, емодзі, опис, пауза (status або paused_until), модель, розклад (лише @manager), бюджет. Режим (off/shadow/approve/live) змінює лише власник у дашборді.',
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
      // Spec 046 FR-007: only @manager runs at its schedule times; the others run at the channel card's plan hour.
      if (patch.schedule && a.kind !== 'manager') {
        return { error: 'schedule_not_used', details: `@${a.handle} працює за годиною планування картки каналу (plan hour), а не за schedule.times — змінюй картку каналу, не розклад агента` };
      }
      const parts = Object.entries(patch).map(([k, v]) => `${k} → ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
      if (!parts.length) return { error: 'empty_patch' };
      return proposeCard(d, ctx, 'update_agent', { handle: a.handle, patch }, `Change @${a.handle}: ${parts.join('; ')}`, a.id);
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
      const r = await proposeCard(d, ctx, 'set_brief', { handle: a.handle, brief }, `New brief for @${a.handle}: ${brief.slice(0, 300)}${brief.length > 300 ? '…' : ''}`, a.id);
      // Spec 034 FR-008: a new brief gets new example posts and warnings.
      return 'ok' in r && a.scopeId ? { ...r, next: `Далі виклич propose_content_examples (handle ${a.handle}, resource_ref ${a.scope === 'network' ? `network:${a.scopeId}` : a.scopeId}) — приклади постів і застереження під новий бриф.` } : r;
    },
  });

  const setProfile = defineTool({
    name: 'set_resource_profile',
    description: 'Запропонувати оновлення профілю ресурсу (тема, аудиторія, цілі, тон, табу, джерела…).',
    kind: 'act', roles: ['builder'],
    input: z.object({ ref: z.string().min(3).max(200), profile: ResourceProfileSchema }),
    execute: async ({ ref, profile }, ctx) => {
      if (!parseResourceRef(ref) && !ref.startsWith('network:')) return { error: 'invalid_ref' };
      return proposeCard(d, ctx, 'set_resource_profile', { ref, profile }, `Update the profile of ${ref}: ${profile.topic}`);
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
      applies_to:  z.array(z.enum(SKILL_ROLES as unknown as [string, ...string[]])).min(1).optional()
        .describe('Ролі; без значення — як у наявного скіла, а для нового скіла каналу — executor, composer, checker'),
      body:        z.string().min(20).max(12_000),
      inline:      z.boolean().optional(),
    }),
    execute: async (i, ctx) => {
      const a = await d.agents.getByHandle(i.handle);
      if (!a) return { error: 'unknown_agent', details: i.handle };
      const shared = await d.skills.findShared(i.name);
      const own = d.skills.findForAgent ? await d.skills.findForAgent(a.id, i.name) : null;
      // Spec 040 FR-012: without roles — the existing skill's, else the writer roles for a channel agent.
      const appliesTo = i.applies_to ?? own?.appliesTo ?? shared?.appliesTo ?? defaultAppliesTo(a);
      if (!appliesTo?.length) return { error: 'new_skill_needs_meta', details: 'для скіла системного агента вкажи applies_to' };
      const lint = lintSkill({ name: i.name, description: i.description, appliesTo, body: i.body, inline: i.inline });
      if (!lint.ok) return { error: 'skill_lint_failed', details: lint.errors };
      if (shared?.safety || isProtectedSkill(i.name)) return { error: 'safety_skill', details: 'системний скіл безпеки чи голосу змінюється лише на сторінці агента з підтвердженням' };
      // Spec 069 FR-002: where the posts come from is an import card, never a skill.
      const wrongPlace = sourceRefusal(i.body);
      if (wrongPlace) return wrongPlace;
      return proposeCard(d, ctx, 'write_skill', { ...i, applies_to: appliesTo, handle: a.handle },
        `${shared ? 'Override' : 'Add'} skill "${i.name}" for @${a.handle}${i.inline ? ' (always in context)' : ''}: ${i.description}`, a.id);
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
        `${name === 'attach_skill' ? 'Enable' : 'Disable'} skill "${skill}" for @${a.handle}${inline ? ' (always in context)' : ''}`, a.id);
    },
  });

  const fixConflicts = defineTool({
    name: 'fix_config_conflicts',
    description: [
      'Одна картка, що узгоджує канал із правилами власника: схвалити чернетку плейбука, що чекає власника; прибрати правила, які неможливо виконати (вказівник, надто розмиті, неіснуючий скіл чи агент);',
      'виправити плейбук і профілі, що суперечать правилам (хештеги вимкнені, ліміт опитувань, без сленгу, аудиторія). Власник може зняти окремі пункти перед Apply. Нічого не пропонує, коли все узгоджено.',
      'Агент каналу — для свого каналу (handle не потрібен); @ai0 — для агента за handle.',
    ].join(' '),
    kind: 'act', roles: ['builder', 'composer'],
    input: z.object({ handle: z.string().min(2).max(40).optional() }),
    execute: async ({ handle }, ctx) => {
      if (!d.conflicts) return { error: 'unavailable' };
      const own = (ctx.extras as { agent?: Agent } | undefined)?.agent ?? null;
      const a = handle ? await d.agents.getByHandle(handle.replace(/^@/, '')) : own;
      if (!a) return { error: handle ? 'unknown_agent' : 'handle_required', details: handle ?? 'назви агента: handle' };
      const orch = a.parentId ? (await d.agents.get?.(a.parentId)) ?? a : a;
      const items = await d.conflicts.resolverFor(orch);
      if (!items.length) return { ok: true, items: [], note: `у @${orch.handle} плейбук, профілі й правила власника узгоджені` };
      return proposeCard(d, ctx, FIX_CONFIG_CONFLICTS_KIND, { handle: orch.handle, items }, fixConflictsSummary(orch.handle, items), orch.id);
    },
  });

  return [listResources, inspectResource, draftProfile, listAgents, getAgent, createAgent, updateAgent, setBrief, setProfile, writeSkill, toggleSkill('attach_skill'), toggleSkill('detach_skill'), fixConflicts];
}
