import type { EvalCase } from '../lib/case';
import { FakeWeb, rss } from '../lib/fake-web';
import { createCard, seedPosts, seedSubscribers, PostSeed } from '../lib/seed';
import { check, stepsOf, toolErrors } from '../lib/graders';
import { localDate, localHour } from '../../src/editor/roles/time';

/** 30 days of history: 19:00 posts and quizzes clearly outperform; crypto posts flop. */
function history(): PostSeed[] {
  const out: PostSeed[] = [];
  for (let d = 1; d <= 28; d++) {
    out.push({ daysAgo: d, hour: 9, format: 'photo', title: `Ранковий знімок ${d}`, views: 480 + (d % 5) * 20 });
    out.push({ daysAgo: d, hour: 13, format: 'text', title: d % 4 === 0 ? `Біткоїн і космос: криптовалюта ${d}` : `Новина дня ${d}`, views: d % 4 === 0 ? 150 : 420 });
    if (d % 2 === 0) out.push({ daysAgo: d, hour: 19, format: 'quiz', title: `Вікторина ${d}`, views: 1100 + (d % 3) * 50, forwards: 30 });
    else out.push({ daysAgo: d, hour: 19, format: 'photo', title: `Вечірній знімок ${d}`, views: 900 });
  }
  return out;
}

const PLAN_CH = '@eval_planner';
export const plannerDailyPlan: EvalCase = {
  id: 'planner-daily-plan', role: 'planner', channel: PLAN_CH,
  title: 'Планувальник: валідний план дня з урахуванням статистики',
  web: () => new FakeWeb({ 'https://plan.example/rss': rss('Space', [{ title: 'Artemis update', link: 'https://plan.example/a', description: 'NASA update on Artemis.' }]) }),
  async execute(ctx) {
    await createCard(ctx.pool, {
      channelKey: PLAN_CH, title: 'Космос щодня', brief: 'Короткі пояснення космічних новин і знімків.',
      formats: { photo: 1, text: 0.6, quiz: 0.5 }, hashtags: ['космос'], postsPerDayMin: 3, postsPerDayMax: 5, minGapMinutes: 90,
      quietStartHour: 23, quietEndHour: 8, exploreRatio: 0.2,
      sources: [{ id: 'space_rss', kind: 'rss', ref: 'https://plan.example/rss' }, { id: 'facts', kind: 'library', ref: 'facts' }],
    });
    await seedPosts(ctx.pool, PLAN_CH, history(), ctx.now);
    await seedSubscribers(ctx.pool, PLAN_CH, [{ daysAgo: 14, subscribers: 1800 }, { daysAgo: 0, subscribers: 1900 }], ctx.now);
    const card = (await ctx.stack.channels.get(PLAN_CH))!;
    const res = await ctx.stack.runner.runPlanner(card);
    const date = localDate(ctx.now, 'Europe/Kyiv');
    const plan = await ctx.stack.plans.getActivePlan(PLAN_CH, date);
    const slots = plan ? await ctx.stack.plans.listSlots(PLAN_CH, plan.id) : [];
    const hours = slots.map((s) => localHour(s.scheduledAt, 'Europe/Kyiv'));
    const steps = await stepsOf(ctx.pool, res.runId);
    const used = steps.filter((s) => s.type === 'tool').map((s) => s.tool_name ?? '?');
    return {
      runId: res.runId, status: res.status, terminalTool: res.terminalTool, toolErrors: toolErrors(steps), toolsUsed: used,
      post: plan ? `${plan.rationale}\n${slots.map((s) => `${String(localHour(s.scheduledAt, 'Europe/Kyiv')).padStart(2, '0')}:${String(s.scheduledAt.getUTCMinutes()).padStart(2, '0')} [${s.format}${s.isExperiment ? ', exp' : ''}] ${s.topic}`).join('\n')}` : '',
      checks: [
        check('plan submitted', res.terminalTool === 'submit_plan' && !!plan, `${res.status} ${res.terminalTool ?? ''}`),
        check('3–5 slots', slots.length >= 3 && slots.length <= 5, String(slots.length)),
        check('uses the best hour (18–20)', hours.some((h) => h >= 18 && h <= 20), hours.join(',')),
        check('includes a quiz (best format)', slots.some((s) => s.format === 'quiz'), slots.map((s) => s.format).join(',')),
        check('topics are specific (≥ 15 chars)', slots.every((s) => s.topic.length >= 15), slots.map((s) => s.topic.length).join(',')),
        check('looked at stats before planning', used.includes('get_channel_stats') || used.includes('get_format_performance') || used.includes('get_top_posts'), used.join(' → ')),
        check('plan accepted on first submit', !toolErrors(steps).some((e) => e.startsWith('submit_plan:')), toolErrors(steps).join(', '), true),
      ],
    };
  },
};

const REV_CH = '@eval_reviewer';
export const reviewerWeekly: EvalCase = {
  id: 'reviewer-weekly-insights', role: 'reviewer', channel: REV_CH,
  title: 'Рецензент: знаходить, що вікторини працюють, а крипто — ні',
  web: () => new FakeWeb(),
  async execute(ctx) {
    await createCard(ctx.pool, {
      channelKey: REV_CH, title: 'Космос щодня', brief: 'Короткі пояснення космічних новин і знімків.',
      formats: { photo: 0.8, text: 0.6, quiz: 0.4 }, hashtags: ['космос'], createdDaysAgo: 40,
    });
    await seedPosts(ctx.pool, REV_CH, history(), ctx.now);
    const card = (await ctx.stack.channels.get(REV_CH))!;
    const res = await ctx.stack.runner.runReviewer(card);
    const memory = await ctx.stack.memory.listActive(REV_CH);
    const after = (await ctx.stack.channels.get(REV_CH))!;
    const steps = await stepsOf(ctx.pool, res.runId);
    const used = steps.filter((s) => s.type === 'tool').map((s) => s.tool_name ?? '?');
    const mem = memory.map((m) => `[${m.kind}] ${m.text}`).join('\n');
    return {
      runId: res.runId, status: res.status, terminalTool: res.terminalTool, toolErrors: toolErrors(steps), toolsUsed: used,
      post: `${(res.terminalResult as any)?.summary ?? ''}\n---\n${mem}\nformats: ${JSON.stringify(after.formats)}`,
      checks: [
        check('finished review', res.terminalTool === 'finish_review', `${res.status} ${res.terminalTool ?? ''}`),
        check('wrote ≥ 1 memory entry', memory.length >= 1, String(memory.length)),
        check('noticed quizzes outperform', /вікторин|quiz/i.test(mem), undefined),
        check('noticed crypto posts flop', /крипт|біткоїн/i.test(mem), undefined, true),
        check('quiz weight not decreased', Number(after.formats.quiz) >= 0.4, String(after.formats.quiz)),
        check('memory entries are concrete (contain a number)', memory.every((m) => /\d/.test(m.text)), undefined, true),
      ],
    };
  },
};

export const PLANNER_REVIEWER_CASES = [plannerDailyPlan, reviewerWeekly];
