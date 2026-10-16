import type { Pool } from 'pg';
import { z } from 'zod';
import { channelOf, defineTool, EditorTool, ToolContext } from '../harness/tool';
import type { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { localDate } from '../roles/time';
import type { Agent } from './agent.types';
import { chatExtras, proposeCard } from './builder-tools';
import type { PendingActionsService } from './pending-actions';
import { ruleOverlap } from './mentions';
import { isProtectedSkill } from '../skills/skill-library';
import { lintSkill, SKILL_ROLES } from './skill-lint';
import type { SkillStore } from './skill-store';
import type { ConfigConflictsService } from '../rules/config-conflicts.service';
import { CHANNEL_SKILL_ROLES, defaultAppliesTo } from '../skills/skill-defaults';

/** Spec 040 FR-010: the pending-action kind of a rule the owner confirms with a card. */
export const OWNER_RULE_KIND = 'owner_rule';
export const RULE_OVERLAP_MIN = 0.5;
/** Spec 040 FR-010: how many of the owner's last messages a rule is compared with. */
export const RULE_SOURCE_MESSAGES = 5;
const KEBAB_RE = /(?<![\p{L}\p{N}_-])[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?![\p{L}\p{N}_-])/gu;

/**
 * Spec 040 FR-010: the skills a rule names (kebab-case names in a rule that speaks of a skill) that exist neither for this
 * agent nor as a shared skill — a rule pointing at a missing skill («завжди дивись poster-bank») only misleads the writer.
 */
export async function unknownSkills(rule: string, known: { get(name: string): unknown } | undefined, shared: Pick<SkillStore, 'findShared'>): Promise<string[]> {
  if (!/скіл|skill/i.test(rule)) return [];
  const out: string[] = [];
  for (const name of new Set(rule.toLowerCase().match(KEBAB_RE) ?? [])) {
    if (known?.get(name)) continue;
    if (await shared.findShared(name).catch(() => null)) continue;
    out.push(name);
  }
  return out;
}

/** The owner's messages a rule paraphrases, best match first (spec 040 FR-010). */
export function ruleSources(rule: string, recent: string[]): Array<{ text: string; overlap: number }> {
  return recent.slice(-RULE_SOURCE_MESSAGES).filter((m) => m.trim())
    .map((m) => ({ text: m, overlap: ruleOverlap(rule, m) }))
    .sort((a, b) => b.overlap - a.overlap);
}

export interface AgentChatToolDeps {
  pool:    Pick<Pool, 'query'>;
  memory:  Pick<EditorMemoryRepository, 'add'>;
  skills:  Pick<SkillStore, 'findShared'>;
  actions: Pick<PendingActionsService, 'propose'>;
  /** Spec 040 FR-011: rules-vs-config, run when a rule is stored. */
  conflicts?: Pick<ConfigConflictsService, 'forAgent'>;
  now?:    () => Date;
}

const agentOf = (ctx: ToolContext): Agent | null => (ctx.extras?.agent as Agent | null | undefined) ?? null;

/**
 * Spec 040 FR-016: the channel the owner or the manager names, in any of its spellings — `telegram:@x`, `@x`, `x`, or a
 * platform resource ref (`instagram:ig1`). Telegram → the channel key `@x`; another platform → its resource ref.
 */
export function slotScopeOf(raw: string): { channelKey: string | null; resourceRef: string | null } {
  const v = raw.trim();
  const m = /^([a-z]+):(.+)$/i.exec(v);
  if (m && m[1].toLowerCase() !== 'telegram') return { channelKey: null, resourceRef: `${m[1].toLowerCase()}:${m[2]}` };
  const name = (m ? m[2] : v).replace(/^@+/, '');
  if (!name) return { channelKey: null, resourceRef: null };
  return { channelKey: `@${name}`, resourceRef: `telegram:@${name}` };
}

/** Spec 040 FR-010: the owner applied an `owner_rule` card — the rule is stored with the quotes it came from. */
export async function applyOwnerRule(memory: Pick<EditorMemoryRepository, 'add'>, p: Record<string, unknown>): Promise<{ id: number; channel: string }> {
  const channel = String(p.channel ?? '');
  const text = String(p.text ?? '').trim();
  const kind = p.kind === 'avoid' ? 'avoid' : 'rule';
  if (!channel || text.length < 8) throw new Error('invalid_rule: the card has no channel or rule text');
  const quotes = Array.isArray(p.quotes) ? p.quotes.map(String).filter(Boolean) : [];
  const id = await memory.add(channel, kind, text, { source: 'owner_card' }, 'owner', quotes.join('\n---\n').slice(0, 2000) || null);
  return { id, channel };
}

/**
 * Tools of a channel agent when the owner talks to it by @handle (spec 018 FR-003):
 * explain its own decisions, take an owner rule, change its own skills (card).
 */
export function buildAgentChatTools(d: AgentChatToolDeps): EditorTool[] {
  const now = d.now ?? (() => new Date());

  const explainDecision = defineTool({
    name: 'explain_decision',
    description: 'Що агент вирішив і чому: слоти дня (або один слот) з форматом, темою, статусом, причиною пропуску/помилки і підсумком прогону. Відповідай власнику лише з цих даних.',
    kind: 'read', roles: ['composer', 'manager'],
    input: z.object({
      date:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD (Київ); за замовчуванням сьогодні'),
      slot_id: z.string().uuid().optional(),
      channel: z.string().max(200).optional().describe('Для менеджера: канал — telegram:@x, @x, x або ref іншої платформи; агент каналу знає свій'),
    }),
    execute: async ({ date, slot_id, channel }, ctx) => {
      const scope = slotScopeOf(channelOf(ctx) ?? channel ?? '');
      if (!scope.channelKey && !scope.resourceRef && !slot_id) return { error: 'no_channel' };
      const day = date ?? localDate(now(), 'Europe/Kyiv');
      const { rows: slots } = await d.pool.query(
        `SELECT s.id, s.scheduled_at, s.kind, s.format, s.topic, s.angle, s.status, s.error, s.is_experiment, s.run_id, s.channel_key, s.resource_ref, p.rationale
           FROM editor_slots s JOIN editor_plans p ON p.id = s.plan_id
          WHERE ($1::uuid IS NOT NULL AND s.id = $1)
             OR ($1::uuid IS NULL AND p.plan_date = $3::date AND p.status = 'active'
                 AND (s.resource_ref = $4 OR (s.channel_key = $2 AND (s.resource_ref IS NULL OR s.resource_ref = $4))))
          ORDER BY s.scheduled_at`, [slot_id ?? null, scope.channelKey, day, scope.resourceRef]);
      const key = scope.channelKey ?? slots[0]?.channel_key ?? null;
      const runIds = slots.map((s) => s.run_id).filter(Boolean);
      const { rows: finals } = runIds.length ? await d.pool.query(
        `SELECT DISTINCT ON (run_id) run_id, tool_name, output
           FROM editor_run_steps WHERE run_id = ANY($1::uuid[]) AND type = 'tool' AND tool_name IN ('publish_post','skip_slot','publish_platform_post')
          ORDER BY run_id, idx DESC`, [runIds]) : { rows: [] as any[] };
      const finalOf = new Map(finals.map((f) => [f.run_id, f]));
      const { rows: plannerRuns } = await d.pool.query(
        `SELECT status, error, started_at FROM editor_runs WHERE role = 'planner' AND channel_key = $1
            AND (started_at AT TIME ZONE 'Europe/Kyiv')::date = $2::date ORDER BY started_at DESC LIMIT 3`, [key, day]);
      return {
        channel: scope.resourceRef ?? key, date: day, plan_rationale: slots[0]?.rationale ?? null,
        ...(slots.length ? {} : { note: `на ${day} немає активного плану зі слотами для ${scope.resourceRef ?? key ?? 'цього каналу'}` }),
        planner_runs: plannerRuns.map((r) => ({ status: r.status, error: r.error, at: r.started_at })),
        slots: slots.map((s) => {
          const f = finalOf.get(s.run_id);
          return {
            id: s.id, at: s.scheduled_at, kind: s.kind, format: s.format, topic: s.topic, angle: s.angle, status: s.status,
            reason: s.error, experiment: s.is_experiment, final_tool: f?.tool_name ?? null,
            final_output: f ? JSON.stringify(f.output).slice(0, 400) : null,
          };
        }),
      };
    },
  });

  const addOwnerRule = defineTool({
    name: 'add_owner_rule',
    description: 'Записати правило власника в памʼять каналу (діє на всі прогони агента). Лише те, що власник сказав у своїх останніх повідомленнях — його словами, коротко й конкретно. Якщо слова не збігаються з його повідомленнями, правило піде йому карткою на підтвердження.',
    kind: 'act', roles: ['composer'],
    input: z.object({ text: z.string().min(8).max(400), kind: z.enum(['rule', 'avoid']).default('rule') }),
    execute: async ({ text, kind }, ctx) => {
      const x = chatExtras(ctx);
      const key = channelOf(ctx);
      if (!key) return { error: 'no_channel' };
      const missing = await unknownSkills(text, ctx.extras?.skills as { get(name: string): unknown } | undefined, d.skills);
      if (missing.length) return { error: 'unknown_skill', details: `таких скілів немає: ${missing.join(', ')} — назви наявний скіл або прибери посилання` };
      const sources = ruleSources(text, x.ownerRecent?.length ? x.ownerRecent : [x.ownerText]);
      const best = sources[0];
      if (best && best.overlap >= RULE_OVERLAP_MIN) {
        const id = await d.memory.add(key, kind, text, { source: 'chat', agent: agentOf(ctx)?.handle ?? null, overlap: Math.round(best.overlap * 100) / 100 }, 'owner', best.text.slice(0, 2000));
        // Spec 040 FR-011: a new rule may contradict the playbook or a profile — say so now, @ai0 fixes it with one card.
        const a = agentOf(ctx);
        const conflicts = a && d.conflicts ? await d.conflicts.forAgent(a).catch(() => []) : [];
        return {
          ok: true, id, channel: key,
          ...(conflicts.length ? { config_conflicts: conflicts.map((c) => c.detail), note: 'плейбук чи профіль суперечать правилам власника — скажи власнику; @ai0 узгодить їх карткою fix_config_conflicts' } : {}),
        };
      }
      // Spec 040 FR-010: not the owner's words (a paraphrase, or text from elsewhere) — the owner decides with a card, never refused.
      const quotes = sources.filter((s) => s.overlap > 0).slice(0, 3).map((s) => s.text.slice(0, 400));
      const a = agentOf(ctx);
      const action = await d.actions.propose({
        chatId: x.chat.chatId, agentId: a?.id ?? null, kind: OWNER_RULE_KIND,
        payload: { channel: key, kind, text, quotes: quotes.length ? quotes : sources.slice(0, 2).map((s) => s.text.slice(0, 400)) },
        summary: `Owner rule for ${key}: ${text}`,
      });
      try { x.onAction?.(action); } catch { /* UI stream only */ }
      return {
        ok: true, pending_action: action.id, stored: false,
        note: `збіг із вашими словами ${Math.round((best?.overlap ?? 0) * 100)}% — правило піде власнику карткою; запишеться лише після його Apply`,
      };
    },
  });

  const editMySkill = defineTool({
    name: 'edit_my_skill',
    description: 'Запропонувати власнику новий скіл або зміну свого скіла (повний текст). Застосується після його кліку Apply.',
    kind: 'act', roles: ['composer'],
    input: z.object({
      name:        z.string().min(3).max(48),
      description: z.string().min(10).max(300),
      applies_to:  z.array(z.enum(SKILL_ROLES as unknown as [string, ...string[]])).min(1).optional()
        .describe('Ролі; без значення — автор поста, чат і критик (executor, composer, checker)'),
      body:        z.string().min(20).max(12_000),
      inline:      z.boolean().optional(),
    }),
    execute: async (i, ctx) => {
      const a = agentOf(ctx);
      if (!a) return { error: 'no_agent', details: 'ця розмова не з агентом каналу — звернись через @handle' };
      // Spec 040 FR-012: a channel skill without roles is for the writers (and the critic judges by it).
      const appliesTo = i.applies_to ?? defaultAppliesTo(a) ?? [...CHANNEL_SKILL_ROLES];
      const lint = lintSkill({ name: i.name, description: i.description, appliesTo, body: i.body, inline: i.inline });
      if (!lint.ok) return { error: 'skill_lint_failed', details: lint.errors };
      if (isProtectedSkill(i.name) || (await d.skills.findShared(i.name))?.safety) return { error: 'safety_skill' };
      return proposeCard(d, ctx, 'write_skill', { ...i, applies_to: appliesTo, handle: a.handle }, `Skill "${i.name}" for @${a.handle}: ${i.description}`, a.id);
    },
  });

  return [explainDecision, addOwnerRule, editMySkill];
}
