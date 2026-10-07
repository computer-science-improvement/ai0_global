import type { Pool } from 'pg';
import type { CaseCtx, EvalCase } from '../lib/case';
import { FakeWeb } from '../lib/fake-web';
import { ownChannel } from '../lib/chat';
import { check, isUkrainian, stepsOf, toolErrors } from '../lib/graders';
import { createCard } from '../lib/seed';
import { localDate, localTimeLabel } from '../../src/editor/roles/time';
import { PlaybookSchema } from '../../src/editor/network/playbook';
import { parseCadence } from '../../src/editor/network/series';
import { normalizePlaybook } from '../../src/editor/network/series-edit';

// Spec 023 T4/T5 live evals: the owner steers the schedule from the chat; the planner honours pins.

const KYIV = 'Europe/Kyiv';

async function resetScheduleAgent(pool: Pool, key: string): Promise<void> {
  const ref = `telegram:${key}`;
  const { rows } = await pool.query(`SELECT id FROM agents WHERE scope_id = $1`, [ref]);
  const ids = rows.map((r) => r.id);
  await pool.query(`DELETE FROM pending_actions WHERE agent_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM playbooks WHERE agent_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM agents WHERE scope_id = $1`, [ref]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [key]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [key]);
  await pool.query(`DELETE FROM editor_chats WHERE id IN (SELECT chat_id FROM editor_drafts WHERE channel_key = $1)`, [key]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [key]);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key = $1`, [key]);
}

const FOOD_CARD = (key: string) => ({
  channelKey: key, title: 'Кухня щодня', brief: 'Прості домашні рецепти і кухонні поради для тих, хто готує вдома.',
  formats: { photo: 1, text: 0.6 }, hashtags: ['рецепт', 'кухня'], postsPerDayMin: 2, postsPerDayMax: 4, minGapMinutes: 60, quietStartHour: 23, quietEndHour: 8,
});

async function seedAgent(ctx: CaseCtx, key: string) {
  await resetScheduleAgent(ctx.pool, key);
  await ownChannel(ctx.pool, key, 'Кухня щодня');
  await createCard(ctx.pool, FOOD_CARD(key));
  await ctx.stack.registrySync.run();
  const orch = (await ctx.stack.agents.findTop('orchestrator', 'resource', `telegram:${key}`))!;
  await ctx.stack.networkRepo.insertPlaybook({
    agentId: orch.id, status: 'active', brief: null, createdBy: 'orchestrator', rationale: 'eval',
    body: PlaybookSchema.parse({
      platforms: [{ resource_ref: `telegram:${key}`, role: 'core', formats: { photo: 1, text: 0.6 }, per_day: { min: 2, max: 4 }, best_hours: [12, 19] }],
      series: [{ name: 'Рецепт дня', cadence: 'daily@19:00', resource_ref: `telegram:${key}`, format: 'photo', brief: 'Домашній рецепт на вечерю з бібліотеки рецептів', source: { kind: 'library', table: 'recipes' } }],
    }),
  });
  return orch;
}

// ── S1: «рецепти о 20:30 по буднях» → a correct series_change card ─────────

const SC = '@eval_sched';
export const chatSeriesChange: EvalCase = {
  id: 'chat-series-change', role: 'composer', channel: SC,
  title: '@agent «рецепти о 20:30 по буднях» → картка series_change (будні 20:30), без змін до Apply',
  web: () => new FakeWeb({}),
  async execute(ctx) {
    const orch = await seedAgent(ctx, SC);
    const chat = await ctx.stack.chat.createChat();
    const { message } = await ctx.stack.chat.sendMessage(chat.id, `@${orch.handle} рецепти о 20:30 по буднях`);
    const { rows: actions } = await ctx.pool.query(`SELECT kind, payload, summary FROM pending_actions WHERE chat_id = $1 ORDER BY created_at`, [chat.id]);
    const card = actions.find((a) => a.kind === 'series_change');
    const cad = card?.payload?.fields?.cadence ? parseCadence(String(card.payload.fields.cadence)) : null;
    const series = normalizePlaybook((await ctx.stack.networkRepo.activePlaybook(orch.id))!.body).series[0];
    const steps = await stepsOf(ctx.pool, message.runId);
    const used = steps.filter((x) => x.type === 'tool').map((x) => x.tool_name ?? '?');
    return {
      runId: message.runId, status: message.content ? 'ok' : 'empty', post: `${card?.summary ?? '(no card)'}\n\n${message.content}`, toolErrors: toolErrors(steps), toolsUsed: used,
      checks: [
        check('a series_change card was proposed', !!card, actions.map((a) => a.kind).join(', ') || 'none'),
        check('it updates "Рецепт дня"', card?.payload?.op === 'update' && card?.payload?.fields?.name === 'Рецепт дня', JSON.stringify(card?.payload ?? null)),
        check('cadence is weekdays at 20:30', !!cad && JSON.stringify(cad.days) === '[1,2,3,4,5]' && cad.times.join(',') === '20:30', card?.payload?.fields?.cadence),
        check('the card shows a human diff', /every day 19:00 → weekdays 20:30/.test(card?.summary ?? ''), card?.summary),
        check('nothing changed before Apply', series.cadence === 'daily@19:00' && !series.locked, `${series.cadence} locked=${series.locked}`),
        check('looked at the schedule first', used.includes('get_schedule'), used.join(' → '), true),
        check('answer in Ukrainian', isUkrainian(message.content), message.content.slice(0, 200), true),
      ],
    };
  },
};

// ── S2: the planner keeps an owner pin and plans around it ──────────────────

const PN = '@eval_pins';
export const plannerHonoursPins: EvalCase = {
  id: 'planner-honours-pins', role: 'planner', channel: PN,
  title: 'Планувальник: закріплений пост власника о 16:00 лишається в плані, інші слоти — щонайменше за 60 хв від нього, серія 19:00 запланована',
  web: () => new FakeWeb({}),
  async execute(ctx) {
    const orch = await seedAgent(ctx, PN);
    const sc: any = await ctx.stack.schedule.scopeByHandle(orch.handle);
    const added: any = await ctx.stack.schedule.addRule(sc, {
      resource_ref: `telegram:${PN}`, kind: 'pin', at_local: '16:00', format: 'text', brief: 'Порада власника: як зберігати зелень свіжою тиждень',
    }, 'owner');
    const card = (await ctx.stack.channels.get(PN))!;
    const res = await ctx.stack.runner.runPlanner(card);
    const date = localDate(ctx.now, KYIV);
    const plan = await ctx.stack.plans.getActivePlan(PN, date);
    const slots = plan ? await ctx.stack.plans.listSlots(PN, plan.id) : [];
    const pins = slots.filter((s) => s.scheduleRuleId);
    const planned = slots.filter((s) => !s.scheduleRuleId && s.kind === 'content');
    const pinAt = pins[0]?.scheduledAt.getTime() ?? 0;
    const steps = await stepsOf(ctx.pool, res.runId);
    const lines = slots.map((s) => `${localTimeLabel(s.scheduledAt, KYIV)} [${s.format}]${s.scheduleRuleId ? ' PIN' : ''}${s.seriesName ? ` series=${s.seriesName}` : ''} ${s.topic}`);
    return {
      runId: res.runId, status: res.status, terminalTool: res.terminalTool, toolErrors: toolErrors(steps),
      post: `${plan?.rationale ?? ''}\n${lines.join('\n')}`,
      checks: [
        check('rule added', !!added?.rule, JSON.stringify(added).slice(0, 200)),
        check('plan submitted', res.terminalTool === 'submit_plan' && !!plan, `${res.status} ${res.terminalTool ?? ''}`),
        check('the pin is in the plan exactly once, still planned', pins.length === 1 && pins[0].status === 'planned', lines.join(' | ')),
        check('no planned slot within 60 min of the pin', planned.every((s) => Math.abs(s.scheduledAt.getTime() - pinAt) >= 60 * 60_000), lines.join(' | ')),
        check('the series instance is planned (series_name, ±90 min of 19:00)', planned.some((s) => s.seriesName === 'Рецепт дня'), lines.join(' | ')),
        check('posts per day incl. the pin within 2–4', slots.length >= 2 && slots.length <= 4, String(slots.length)),
        check('plan accepted on first submit', !toolErrors(steps).some((e) => e.startsWith('submit_plan:')), toolErrors(steps).join(', '), true),
      ],
    };
  },
};

export const SCHEDULE_CASES: EvalCase[] = [chatSeriesChange, plannerHonoursPins];
