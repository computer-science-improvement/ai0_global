import { z } from 'zod';
import { defineTool, EditorTool, ToolContext } from '../harness/tool';
import type { Agent } from '../agents/agent.types';
import { chatExtras } from '../agents/builder-tools';
import type { PendingActionsService } from '../agents/pending-actions';
import type { EditorCard } from '../card';
import { localDate } from '../roles/time';
import { ScheduleRulePatch, shiftDate, type ScheduleRuleInput } from './schedule-rules';
import { isFail, type Fail, type ScheduleScope, ScheduleService, SLOT_CHANGE_HOURS } from './schedule.service';
import { SERIES_OPS, SeriesFields } from './series-change';

/**
 * Chat steering of the schedule (spec 023 FR-006): composer and agent chat only (the tools need a chat
 * context and are `chatOnly`: never given to autonomous roles). Spec 040 FR-013: @manager gets the read tool and the
 * slot cards for any resource (named by `channel` or by the slot), with `regenerate` and `propose_replan_today`.
 * One read tool and the proposals; each proposal is
 * validated now and again at Apply (a stale card fails), and needs an explicit request in the owner's last
 * message. Card summaries are English (the dashboard shows them); results for the model stay data.
 */

export interface ScheduleToolDeps {
  schedule: ScheduleService;
  actions:  Pick<PendingActionsService, 'propose'>;
  now?:     () => Date;
}

export const SCHEDULE_ACTIONS = ['series_change', 'schedule_rule', 'slot_change', 'slot_regenerate', 'replan_today'] as const;
/** Spec 040 FR-013: write a planned slot now / replan the rest of today (handlers need the editor ops: registerAgentActions). */
export const SLOT_REGENERATE_KIND = 'slot_regenerate';
export const REPLAN_TODAY_KIND = 'replan_today';

/** What a tool call names: a target (@handle, channel, resource ref) and / or a slot. */
interface ScopeTarget { channel?: string | null; slotId?: string | null }

/**
 * The schedule a chat call works on (spec 040 FR-013). A channel agent: its own (another target is out of scope).
 * @manager / @ai0: the slot's, else the named target's, else the chat's channel.
 */
async function scopeOf(d: ScheduleToolDeps, ctx: ToolContext, t: ScopeTarget = {}): Promise<ScheduleScope | Fail> {
  const agent = (ctx.extras?.agent as Agent | null | undefined) ?? null;
  if (agent && agent.kind !== 'builder' && agent.kind !== 'manager') {
    const own = await d.schedule.scopeOf(agent);
    if (isFail(own) || !t.channel) return own;
    const other = await d.schedule.scopeByTarget(t.channel);
    if (!isFail(other) && other.agent.id !== own.agent.id) {
      return { error: 'out_of_scope', details: `@${own.agent.handle} керує лише своїм розкладом; розклад ${t.channel} — у @${other.agent.handle} або @manager` };
    }
    return own;
  }
  if (t.slotId) return d.schedule.scopeBySlot(t.slotId);
  if (t.channel) return d.schedule.scopeByTarget(t.channel);
  const x = chatExtras(ctx);
  const key = x.chat.channelKey ?? ctx.channelKey ?? (ctx.extras?.card as EditorCard | undefined)?.channelKey ?? null;
  if (!key) return { error: 'no_channel', details: 'назви ресурс: channel = @handle агента, @канал або resource_ref (telegram:@x)' };
  return d.schedule.scopeByChannel(key);
}

const CHANNEL_ARG = z.string().min(2).max(200).optional()
  .describe('Чий розклад: @handle агента, @канал або resource_ref. Агенту каналу не потрібно (лише свій); @manager — обовʼязково, якщо немає slot_id');

const outFail = (f: Fail) => ({ error: f.error, ...(f.details !== undefined ? { details: f.details } : {}) });

async function propose(d: ScheduleToolDeps, ctx: ToolContext, kind: string, payload: Record<string, unknown>, summary: string, agentId: string, extra: Record<string, unknown> = {}) {
  const x = chatExtras(ctx);
  const action = await d.actions.propose({ chatId: x.chat.chatId, agentId, kind, payload, summary });
  try { x.onAction?.(action); } catch { /* UI stream only */ }
  return { ok: true, pending_action: action.id, summary, ...extra, note: 'Власник побачить картку з кнопками Apply / Discard — зміна застосується лише після його кліку.' };
}

export function buildScheduleTools(d: ScheduleToolDeps): EditorTool[] {
  const now = d.now ?? (() => new Date());

  const getSchedule = defineTool({
    name: 'get_schedule',
    description: 'Розклад агента: серії (хто власник, чи заблоковані власником), правила власника (закріплені пости, заборонені вікна, частота), заплановані слоти на найближчі 48 год і резервні (рекламні) слоти. Час — у часовому поясі кожного ресурсу.',
    kind: 'read', roles: ['composer', 'manager'], chatOnly: true,
    input: z.object({
      channel:      CHANNEL_ARG,
      resource_ref: z.string().min(3).max(200).optional(),
      days:         z.number().int().min(1).max(7).default(7),
    }),
    execute: async ({ channel, resource_ref, days }, ctx) => {
      const sc = await scopeOf(d, ctx, { channel: channel ?? resource_ref ?? null });
      if (isFail(sc)) return outFail(sc);
      const t = now();
      const from = localDate(t, sc.card.timezone);
      const s = await d.schedule.schedule(sc, { from, to: shiftDate(from, days - 1), resourceRef: resource_ref ?? null });
      const horizon = t.getTime() + SLOT_CHANGE_HOURS * 3600_000;
      const live = (x: { at: string }) => new Date(x.at).getTime() >= t.getTime();
      return {
        agent: `@${sc.agent.handle}`, playbook_version: s.playbookVersion,
        resources: s.resources.map((r) => ({ ref: r.ref, timezone: r.timezone, per_day: r.perDay })),
        series: s.series, rules: s.rules,
        planned_48h: s.slots.filter((x) => x.kind === 'content' && live(x) && new Date(x.at).getTime() <= horizon && ['planned', 'awaiting_approval', 'approved'].includes(x.status))
          .map(({ id, resourceRef, date, time, status, format, topic, seriesName, scheduleRuleId }) => ({ id, resource_ref: resourceRef, date, time, status, format, topic, series: seriesName, pin: !!scheduleRuleId })),
        reserved: s.slots.filter((x) => x.kind === 'reserved' && live(x)).map(({ id, resourceRef, date, time, status, topic }) => ({ id, resource_ref: resourceRef, date, time, status, topic })),
      };
    },
  });

  const proposeSeries = defineTool({
    name: 'propose_series_change',
    description: 'Запропонувати власнику зміну серії (картка Apply): add — нова серія; update — змінити поля (cadence daily@HH:MM або weekly:mon,thu@HH:MM у часі ресурсу, format, brief, source, source_mode); pause / resume / remove. Після Apply серію веде власник (заблокована для агента). Лише коли власник прямо попросив в останньому повідомленні.',
    kind: 'act', roles: ['composer'], chatOnly: true,
    input: z.object({ op: z.enum(SERIES_OPS), series: SeriesFields }),
    execute: async ({ op, series }, ctx) => {
      const sc = await scopeOf(d, ctx);
      if (isFail(sc)) return outFail(sc);
      const prep = await d.schedule.prepareSeriesChange(sc, op, series);
      if (isFail(prep)) return outFail(prep);
      return propose(d, ctx, 'series_change', { agent_id: sc.agent.id, op, fields: prep.fields, before: prep.before },
        `Series change for @${sc.agent.handle}: ${prep.diff}`, sc.agent.id, { diff: prep.diff });
    },
  });

  const proposeRule = defineTool({
    name: 'propose_schedule_rule',
    description: 'Запропонувати правило розкладу (картка Apply): kind pin — закріплений пост о at_local (format + brief або series_name); blackout — без постів між at_local і until_local; frequency — per_day_min/max замість плейбука. days: 0 = неділя (null — щодня), час — у часовому поясі ресурсу. op add | update (rule_id + змінені поля) | disable (rule_id). Лише на пряме прохання власника.',
    kind: 'act', roles: ['composer'], chatOnly: true,
    input: z.object({
      op:      z.enum(['add', 'update', 'disable']),
      rule_id: z.string().uuid().optional(),
      rule:    ScheduleRulePatch.optional().describe('Для add — повне правило (resource_ref, kind, …); для update — лише змінені поля'),
    }),
    execute: async ({ op, rule_id, rule }, ctx) => {
      const sc = await scopeOf(d, ctx);
      if (isFail(sc)) return outFail(sc);
      if (op === 'add') {
        const { active: _a, ...input } = rule ?? {};
        const chk = await d.schedule.checkRule(sc, input);
        if (chk.errors.length) return { error: 'rule_invalid', details: chk.errors };
        return propose(d, ctx, 'schedule_rule', { agent_id: sc.agent.id, op, rule: chk.rule },
          `${d.schedule.ruleSummary('add', chk.rule)}${chk.warnings.length ? ` (warnings: ${chk.warnings.join(', ')})` : ''}`, sc.agent.id, { warnings: chk.warnings });
      }
      if (!rule_id) return { error: 'rule_id_required' };
      const cur = await d.schedule.rule(sc, rule_id);
      if (!cur) return { error: 'rule_not_found' };
      const patch = op === 'disable' ? { active: false } : (() => { const { active: _a, ...p } = rule ?? {}; return p; })();
      const merged = { ...d.schedule.ruleInput(cur), ...patch };
      if (op === 'update') {
        const chk = await d.schedule.checkRule(sc, merged);
        if (chk.errors.length) return { error: 'rule_invalid', details: chk.errors };
      }
      const { active: _x, ...shown } = merged as ScheduleRuleInput & { active?: boolean };
      return propose(d, ctx, 'schedule_rule', { agent_id: sc.agent.id, op, rule_id, patch, before: cur.updatedAt.toISOString() },
        d.schedule.ruleSummary(op, shown, cur), sc.agent.id);
    },
  });

  const proposeSlot = defineTool({
    name: 'propose_slot_change',
    description: `Запропонувати змінити запланований слот контенту в найближчі ${SLOT_CHANGE_HOURS} год (id з get_schedule): move — перенести (to_local HH:MM або YYYY-MM-DD HH:MM у часі ресурсу); skip — пропустити; regenerate — написати пост зараз (автор запускається одразу, а не в час слота). Одна картка Apply на слот; лише на пряме прохання власника.`,
    kind: 'act', roles: ['composer', 'manager'], chatOnly: true,
    input: z.object({ slot_id: z.string().uuid(), op: z.enum(['move', 'skip', 'regenerate']), to_local: z.string().max(20).optional() }),
    execute: async ({ slot_id, op, to_local }, ctx) => {
      const sc = await scopeOf(d, ctx, { slotId: slot_id });
      if (isFail(sc)) return outFail(sc);
      if (op === 'regenerate') {
        const r = await d.schedule.prepareRegenerate(sc, slot_id);
        if (isFail(r)) return outFail(r);
        return propose(d, ctx, SLOT_REGENERATE_KIND, { agent_id: sc.agent.id, slot_id, channel_key: sc.card.channelKey }, r.summary, sc.agent.id);
      }
      const prep = await d.schedule.prepareSlotChange(sc, slot_id, op, to_local ?? null);
      if (isFail(prep)) return outFail(prep);
      return propose(d, ctx, 'slot_change', {
        agent_id: sc.agent.id, slot_id, op, from: prep.slot.scheduledAt.toISOString(), to: prep.to ? prep.to.toISOString() : null,
      }, `${prep.summary}${prep.warnings.length ? ` (warnings: ${prep.warnings.join(', ')})` : ''}`, sc.agent.id, { warnings: prep.warnings });
    },
  });

  const proposeReplan = defineTool({
    name: 'propose_replan_today',
    description: 'Запропонувати перепланувати решту сьогоднішнього дня ресурсу (картка Apply): планувальник замінює майбутні заплановані слоти; написані, ті, що вже пишуться, закріплені й резервні лишаються. Одна картка на ресурс (кілька ресурсів — кілька викликів); лише на пряме прохання власника.',
    kind: 'act', roles: ['composer', 'manager'], chatOnly: true,
    input: z.object({ channel: CHANNEL_ARG, reason: z.string().max(300).optional().describe('Що змінити в плані — піде в підсумок картки') }),
    execute: async ({ channel, reason }, ctx) => {
      const sc = await scopeOf(d, ctx, { channel: channel ?? null });
      if (isFail(sc)) return outFail(sc);
      const tz = sc.card.timezone;
      return propose(d, ctx, REPLAN_TODAY_KIND, { agent_id: sc.agent.id, channel_key: sc.card.channelKey, reason: reason ?? null },
        `Replan the rest of today (${localDate(now(), tz)}) for ${sc.card.channelKey} (@${sc.agent.handle}): future planned slots are replaced; written, running and pinned slots stay${reason ? `. ${reason}` : ''}`,
        sc.agent.id);
    },
  });

  return [getSchedule, proposeSeries, proposeRule, proposeSlot, proposeReplan];
}

/**
 * Spec 040 FR-013: the slot_regenerate / replan_today card handlers. They run the editor ops (registered where the ops
 * exist); the ops re-check at Apply (the slot is still planned, the channel is not off, no replan is running).
 */
export function registerSlotRunActions(
  actions: Pick<PendingActionsService, 'register'>,
  ops: { runSlot(id: string, o: { wait?: boolean }): Promise<unknown>; replan(key: string, o: { wait?: boolean }): Promise<unknown> },
): void {
  actions.register(SLOT_REGENERATE_KIND, async (p) => {
    await ops.runSlot(String(p.slot_id), { wait: false });
    return { started: true, slot: String(p.slot_id) };
  });
  actions.register(REPLAN_TODAY_KIND, async (p) => {
    await ops.replan(String(p.channel_key), { wait: false });
    return { started: true, channel: String(p.channel_key) };
  });
}

/** The three card handlers (spec 023 FR-006): re-validated at Apply; a stale card throws → `failed`. */
export function registerScheduleActions(actions: Pick<PendingActionsService, 'register'>, schedule: ScheduleService): void {
  const scope = async (p: Record<string, unknown>) => {
    const sc = await schedule.scopeById(String(p.agent_id));
    if (isFail(sc)) throw new Error(`${sc.error}${sc.details ? `: ${String(sc.details)}` : ''}`);
    return sc;
  };
  const fail = (f: Fail): never => { throw new Error(`${f.error}${f.details ? `: ${Array.isArray(f.details) ? f.details.join('; ') : String(f.details)}` : ''}`); };

  actions.register('series_change', async (p) => {
    const sc = await scope(p);
    const r = await schedule.commitSeriesChange(sc, p.op as any, p.fields, { expectBefore: (p.before as string | null) ?? null, source: 'chat' });
    if (isFail(r)) return fail(r);
    return { version: r.version, diff: r.diff };
  });
  actions.register('schedule_rule', async (p) => {
    const sc = await scope(p);
    const r = p.op === 'add'
      ? await schedule.addRule(sc, p.rule, 'chat')
      : await schedule.updateRule(sc, String(p.rule_id), p.patch, { expectUpdatedAt: String(p.before ?? '') || null });
    if (isFail(r)) return fail(r);
    return { rule: r.rule.id, warnings: r.warnings };
  });
  actions.register('slot_change', async (p) => {
    await scope(p);
    const r = await schedule.applySlotChange(String(p.slot_id), p.op as 'move' | 'skip', new Date(String(p.from)), p.to ? new Date(String(p.to)) : null);
    if (isFail(r)) return fail(r);
    return { slot: r.slot.id, status: r.slot.status, at: r.slot.scheduledAt.toISOString() };
  });
}
