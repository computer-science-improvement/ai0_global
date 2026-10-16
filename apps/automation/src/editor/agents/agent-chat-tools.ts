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

export const RULE_OVERLAP_MIN = 0.5;

export interface AgentChatToolDeps {
  pool:    Pick<Pool, 'query'>;
  memory:  Pick<EditorMemoryRepository, 'add'>;
  skills:  Pick<SkillStore, 'findShared'>;
  actions: Pick<PendingActionsService, 'propose'>;
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
    description: 'Записати правило власника в памʼять каналу (діє на всі прогони агента). Лише те, що власник сказав у ОСТАННЬОМУ повідомленні — своїми словами, коротко.',
    kind: 'act', roles: ['composer'],
    input: z.object({ text: z.string().min(8).max(400), kind: z.enum(['rule', 'avoid']).default('rule') }),
    execute: async ({ text, kind }, ctx) => {
      const x = chatExtras(ctx);
      const key = channelOf(ctx);
      if (!key) return { error: 'no_channel' };
      const overlap = ruleOverlap(text, x.ownerText);
      if (overlap < RULE_OVERLAP_MIN) {
        return { error: 'not_owner_words', details: `правило має переказувати останнє повідомлення власника (збіг ${Math.round(overlap * 100)}%)` };
      }
      const id = await d.memory.add(key, kind, text, { source: 'chat', agent: agentOf(ctx)?.handle ?? null }, 'owner');
      return { ok: true, id, channel: key };
    },
  });

  const editMySkill = defineTool({
    name: 'edit_my_skill',
    description: 'Запропонувати власнику новий скіл або зміну свого скіла (повний текст). Застосується після його кліку Apply.',
    kind: 'act', roles: ['composer'],
    input: z.object({
      name:        z.string().min(3).max(48),
      description: z.string().min(10).max(300),
      applies_to:  z.array(z.enum(SKILL_ROLES as unknown as [string, ...string[]])).min(1),
      body:        z.string().min(20).max(12_000),
      inline:      z.boolean().optional(),
    }),
    execute: async (i, ctx) => {
      const a = agentOf(ctx);
      if (!a) return { error: 'no_agent', details: 'ця розмова не з агентом каналу — звернись через @handle' };
      const lint = lintSkill({ name: i.name, description: i.description, appliesTo: i.applies_to, body: i.body, inline: i.inline });
      if (!lint.ok) return { error: 'skill_lint_failed', details: lint.errors };
      if (isProtectedSkill(i.name) || (await d.skills.findShared(i.name))?.safety) return { error: 'safety_skill' };
      return proposeCard(d, ctx, 'write_skill', { ...i, handle: a.handle }, `Skill "${i.name}" for @${a.handle}: ${i.description}`, a.id);
    },
  });

  return [explainDecision, addOwnerRule, editMySkill];
}
