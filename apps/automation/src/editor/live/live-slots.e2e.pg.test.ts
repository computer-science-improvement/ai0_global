/**
 * Spec 034 FR-010 / FR-011 end to end on a throwaway Postgres, a scripted LLM and a fake feed (no network):
 * the morning plan has a live slot; a feed item published at 14:50 is picked up by the news watch at 15:00
 * and written the same day; the 16:00 live slot then finds nothing fresh (the item is used) and is skipped
 * with `no_fresh_item` without an LLM call; a replan keeps written slots. All on a fixed 2030 date, so the
 * test never depends on the hour it runs at. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AgentLoop } from '../harness/agent-loop';
import { ToolRegistry } from '../harness/tool-registry';
import { PgRunRecorder } from '../harness/run-recorder';
import { BudgetService } from '../harness/budget.service';
import { FakeLlm } from '../harness/testing/fakes';
import { ReadonlyQueryService } from '../db/readonly-query.service';
import { SkillLibrary } from '../skills/skill-library';
import { buildReadTools } from '../tools/read-tools';
import { buildComposeTools } from '../tools/compose-tools';
import { buildRoleTools } from '../tools/role-tools';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { EditorPlansRepository } from '../repo/editor-plans.repository';
import { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { EditorRunnerService } from '../roles/editor-runner.service';
import { makeDefaultCard } from '../chat/default-card';
import { ScheduleRepository } from '../schedule/schedule.repository';
import { ScheduleService } from '../schedule/schedule.service';
import { validatePlan, SubmitPlanInput } from '../roles/plan-rules';
import { scanLive } from './feed-items';
import { NewsWatchService } from './news-watch';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@live_e2e_pg';
const CH2 = '@live_replan_pg';
const FEED = 'https://energy.example/rss';
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
let pool: Pool;

// Kyiv is UTC+3 on 2030-05-06.
const at = (hhmm: string) => new Date(`2030-05-06T${String(Number(hhmm.slice(0, 2)) - 3).padStart(2, '0')}:${hhmm.slice(3)}:00Z`);

const NEW = { title: 'Уряд ухвалив закон про енергоринок', link: 'https://energy.example/new', date: at('14:50').toISOString() };
const OLD = { title: 'Енергетики підбили підсумки зими', link: 'https://energy.example/old', date: '2030-05-05T06:00:00Z' };
const OFF = { title: 'Футбольний клуб підписав нападника', link: 'https://energy.example/sport', date: at('14:40').toISOString() };
let feedItems = [NEW, OLD, OFF];
const rss = () => `<?xml version="1.0"?><rss version="2.0"><channel><title>Energy</title>${
  feedItems.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${new Date(i.date).toUTCString()}</pubDate><description>Подробиці</description></item>`).join('')
}</channel></rss>`;
const get = async (u: string) => {
  if (u !== FEED) throw new Error(`unexpected fetch ${u}`);
  return { status: 200, headers: { 'content-type': 'application/rss+xml' }, data: rss() };
};

async function cleanup() {
  for (const ch of [CH, CH2]) {
    await pool.query(`DELETE FROM news_watch_log WHERE channel_key = $1`, [ch]);
    await pool.query(`DELETE FROM content_ledger WHERE resource_ref = $1`, [`telegram:${ch}`]);
    await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [ch]);
    await pool.query(`DELETE FROM editor_runs WHERE channel_key = $1`, [ch]);
    await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [ch]);
  }
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  const channels = new EditorChannelsRepository(pool);
  for (const ch of [CH, CH2]) {
    await channels.insertIfMissing({
      ...makeDefaultCard(ch, 'Енергія'), mode: 'shadow', planHour: 0, quietStartHour: 23, quietEndHour: 7, minGapMinutes: 30,
      postsPerDayMin: 1, postsPerDayMax: 5, formats: { text: 1 }, brief: 'Новини енергетики України', hashtags: ['енергетика'],
      sources: [{ id: 'feed1', kind: 'rss', ref: FEED }],
    });
  }
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const spec = (title: string, link: string) => ({
  format: 'text', title, origin: 'external',
  body: [
    { type: 'lead', text: `${title}.` },
    { type: 'p', text: 'Документ змінює правила для постачальників і споживачів. Нові норми почнуть діяти з наступного місяця.' },
  ],
  hashtags: ['енергетика'],
  source: { url: link, label: 'Energy' },
});

test('a 15:00 feed item is posted the same day (news watch → live slot), the 16:00 live slot skips with no_fresh_item, no repeats', { skip }, async () => {
  let clock = at('06:00');
  const now = () => clock;
  const channels = new EditorChannelsRepository(pool);
  const plans = new EditorPlansRepository(pool);
  const memory = new EditorMemoryRepository(pool);
  const skills = new SkillLibrary();
  const registry = new ToolRegistry([
    ...buildReadTools({ pool, readonly: new ReadonlyQueryService(pool), skills, http: { lookup, get }, now }),
    ...buildComposeTools(),
    ...buildRoleTools({ pool, plans, memory, channels, publisher: { send: async () => { throw new Error('never sends in shadow'); } }, recordPublish: () => {}, now }),
  ]);
  const llm = new FakeLlm([
    // 06:00 planner: one fixed slot and one live slot (no topic).
    { calls: [{ name: 'submit_plan', args: {
      rationale: 'Ранковий пояснювальний пост і новина дня наживо о 16:00.',
      slots: [
        { time: '09:00', format: 'text', topic: 'Як читати рахунок за електроенергію' },
        { time: '16:00', format: 'text', topic_mode: 'live', source: ['feed1'], brief: 'Головна новина енергетики за день' },
      ],
    } }] },
    // 15:16 executor of the news-watch slot.
    { calls: [{ name: 'fetch_feed', args: { url: FEED, since_hours: 6, exclude_posted: true } }] },
    { calls: [{ name: 'publish_post', args: { spec: spec(NEW.title, NEW.link) } }] },
  ]);
  const loop = new AgentLoop({ llm, recorder: new PgRunRecorder(pool), enabled: () => true, budget: new BudgetService(pool, { globalDailyUsd: 100, channelDailyUsd: 100 }) });
  const runner = new EditorRunnerService({
    loop, registry, skills, plans, memory, env: () => undefined, notify: async () => {}, now,
    live: { scan: async (slot, card) => scanLive({ pool, http: { lookup, get } }, { spec: slot.liveSpec!, resourceRef: `telegram:${slot.channelKey}`, card: card.sources, now: clock, excludeSlotId: slot.id }) },
  });
  const watch = new NewsWatchService({ pool, profile: async () => null, http: { lookup, get } });
  const card = (await channels.get(CH))!;

  // ── 06:00: the plan ───────────────────────────────────────────────────────
  const planRes = await runner.runPlanner(card);
  assert.equal(planRes.terminalTool, 'submit_plan', JSON.stringify(planRes));
  const plan = (await plans.getActivePlan(CH, '2030-05-06'))!;
  const [morning, live16] = await plans.listSlots(CH, plan.id);
  assert.equal(morning.topicMode, undefined);
  assert.deepEqual([live16.topicMode, live16.topic, live16.liveSpec?.sources, live16.scheduledAt.toISOString()], ['live', 'Свіжа новина з feed1', ['feed1'], at('16:00').toISOString()]);
  // 09:00 was written (shadow) on its own topic.
  await plans.updateSlot(morning.id, { status: 'shadowed', postSpec: spec('Як читати рахунок', 'https://energy.example/morning'), renderedPreview: 'Як читати рахунок за електроенергію: три рядки, які варто знати.' });

  // ── 15:00: the news watch finds the 14:50 item and adds a live slot ─────
  clock = at('15:00');
  const r1 = await watch.check(card, clock);
  assert.equal(r1.status, 'checked');
  const added = r1.status === 'checked' ? r1.added : null;
  assert.ok(added, JSON.stringify(r1));
  assert.equal(added!.url, NEW.link);
  assert.equal(added!.at.toISOString(), at('15:15').toISOString(), '15 min ahead, ≥ 30 min from the 16:00 slot');
  const w = (await plans.getSlot(added!.slotId))!;
  assert.deepEqual([w.topicMode, w.liveSpec?.origin, w.liveSpec?.item?.url, w.planId], ['live', 'news_watch', NEW.link, plan.id]);
  const log1 = (await pool.query(`SELECT decision, reason, item_url FROM news_watch_log WHERE channel_key = $1 ORDER BY id`, [CH])).rows;
  assert.deepEqual(log1.map((x) => [x.decision, x.item_url, x.decision === 'ignored' ? x.reason : null]),
    [['ignored', OFF.link, 'off_topic'], ['added', NEW.link, null], ['checked', null, null]]);

  // Not due again for 2 h; a forced re-check does not add the same item twice (the live slot holds it).
  assert.equal((await watch.check(card, at('15:05'))).status, 'not_due');
  const r2 = await watch.check(card, at('15:05'), { force: true });
  assert.equal(r2.status === 'checked' && r2.added, null);
  const watchSlots = (await pool.query(`SELECT count(*)::int AS n FROM editor_slots WHERE channel_key = $1 AND live_spec->>'origin' = 'news_watch'`, [CH])).rows[0].n;
  assert.equal(watchSlots, 1);

  // ── 15:16: the news-watch slot is written from the 14:50 item ────────────
  clock = at('15:16');
  const due = (await plans.claimDue(clock, 10)).filter((s) => s.channelKey === CH);
  assert.deepEqual(due.map((s) => s.id), [added!.slotId], 'the 16:00 slot is not due yet');
  const exec = await runner.runExecutor(due[0], card);
  assert.equal(exec.terminalTool, 'publish_post', JSON.stringify(exec));
  const userPrompt = String(llm.requests[1].messages.find((m) => m.role === 'user')!.content);
  assert.match(userPrompt, /live-слот: тема НЕ задана/);
  assert.match(userPrompt, /Код додав цей слот під свіжий матеріал: «Уряд ухвалив закон про енергоринок»/);
  assert.match(userPrompt, /1\. «Уряд ухвалив закон про енергоринок» — https:\/\/energy\.example\/new/);
  assert.doesNotMatch(userPrompt, /Енергетики підбили підсумки зими/, 'an old item is not a candidate');
  const written = (await plans.getSlot(added!.slotId))!;
  assert.equal(written.status, 'shadowed');
  assert.equal((written.postSpec as any).source.url, NEW.link);

  // ── 16:01: the planner's live slot finds nothing fresh — skipped by code, no LLM call ──
  feedItems = [NEW, OLD];
  clock = at('16:01');
  const calls = llm.requests.length;
  const due16 = (await plans.claimDue(clock, 10)).filter((s) => s.channelKey === CH);
  assert.deepEqual(due16.map((s) => s.id), [live16.id]);
  const skipped = await runner.runExecutor(due16[0], card);
  assert.equal(llm.requests.length, calls, 'no LLM call');
  const s16 = (await plans.getSlot(live16.id))!;
  assert.equal(s16.status, 'skipped');
  assert.match(s16.error!, /^no_fresh_item: no item ≤ 6 h in feed1 .*1 old, 0 undated, 1 posted/);
  assert.equal(skipped.error, s16.error);

  // No repeats: the 14:50 item is used exactly once on the channel.
  const used = (await pool.query(`SELECT count(*)::int AS n FROM content_ledger WHERE resource_ref = $1 AND source_ref = $2`, [`telegram:${CH}`, NEW.link])).rows[0].n;
  assert.equal(used, 1);
  const posts = (await pool.query(`SELECT count(*)::int AS n FROM editor_slots WHERE channel_key = $1 AND post_spec->'source'->>'url' = $2`, [CH, NEW.link])).rows[0].n;
  assert.equal(posts, 1);
});

test('a replan replaces only future planned slots; written, running and due slots stay and count as fixed points', { skip }, async () => {
  const plans = new EditorPlansRepository(pool, () => at('12:00'));
  const card = (await new EditorChannelsRepository(pool).get(CH2))!;
  const planId = await plans.createPlan(CH2, '2030-05-06', 'morning plan', null, [
    { scheduledAt: at('09:00'), format: 'text', topic: 'Опублікований зранку', angle: null, sourceHints: [], isExperiment: false },
    { scheduledAt: at('11:58'), format: 'text', topic: 'Виконується зараз', angle: null, sourceHints: [], isExperiment: false },
    { scheduledAt: at('12:03'), format: 'text', topic: 'Ось-ось час', angle: null, sourceHints: [], isExperiment: false },
    { scheduledAt: at('18:00'), format: 'text', topic: 'Написаний, чекає апруву', angle: null, sourceHints: [], isExperiment: false },
    { scheduledAt: at('20:00'), format: 'text', topic: 'Ще не написаний', angle: null, sourceHints: [], isExperiment: false },
  ]);
  const slots = await plans.listSlots(CH2, planId);
  const by = (t: string) => slots.find((s) => s.topic === t)!;
  await plans.updateSlot(by('Опублікований зранку').id, { status: 'shadowed', renderedPreview: 'Опублікований зранку' });
  await plans.updateSlot(by('Виконується зараз').id, { status: 'running' });
  await plans.updateSlot(by('Написаний, чекає апруву').id, { status: 'awaiting_approval' });

  // The planner's context: kept slots are fixed points (count, gap); the future planned one is not.
  const schedule = new ScheduleService({ pool, rules: new ScheduleRepository(pool), network: {} as any, agents: {} as any, card: async () => card, plans: {} as any, inbox: {} as any });
  const ctx = await schedule.planContext(card, null, '2030-05-06', at('12:00'), 'single');
  assert.deepEqual(ctx.pins.map((p) => [p.kept?.status, p.at.toISOString()]), [
    ['shadowed', at('09:00').toISOString()], ['running', at('11:58').toISOString()], ['planned', at('12:03').toISOString()],
    ['awaiting_approval', at('18:00').toISOString()],
  ]);
  const eff = schedule.effectiveCard(card, ctx);
  assert.equal(eff.postsPerDayMax, 1, '5 per day minus the 4 kept');
  const tooMany = validatePlan(SubmitPlanInput.parse({ rationale: 'Дві нові новини ввечері.', slots: [
    { time: '19:00', format: 'text', topic: 'Вечірній огляд ринку' }, { time: '21:00', format: 'text', topic: 'Ще одна тема дня' },
  ] }), eff, '2030-05-06', at('12:00'), [], ctx);
  assert.equal(tooMany.ok, false);
  const near = validatePlan(SubmitPlanInput.parse({ rationale: 'Одна нова новина біля апруву.', slots: [{ time: '18:10', format: 'text', topic: 'Вечірній огляд ринку' }] }), eff, '2030-05-06', at('12:00'), [], ctx);
  assert.match(!near.ok ? near.errors.join('\n') : '', /занадто близько до поста, що вже є в плані о 18:00 \(awaiting_approval/);
  const v = validatePlan(SubmitPlanInput.parse({ rationale: 'Одна нова новина ввечері.', slots: [{ time: '21:00', format: 'text', topic_mode: 'live', brief: 'Вечірня новина' }] }), eff, '2030-05-06', at('12:00'), [], ctx);
  assert.ok(v.ok, JSON.stringify(v));

  // A live slot's post must name its item (the ledger stops a repeat by that URL).
  const liveSlot = { ...by('Ще не написаний'), topicMode: 'live' as const, liveSpec: { sources: ['feed1'], brief: 'x', max_age_hours: 6, origin: 'planner' as const } };
  assert.equal((await schedule.publishGuard(liveSlot, { sourceUrl: null }, { live: false, now: at('12:00') }))?.error, 'live_source_missing');
  assert.equal(await schedule.publishGuard(liveSlot, { sourceUrl: 'https://energy.example/x' }, { live: false, now: at('12:00') }), null);

  // The replan itself.
  const newPlan = await plans.createPlan(CH2, '2030-05-06', 'replan', null, v.ok ? v.slots : []);
  const after = await pool.query(`SELECT topic, status, plan_id, error, topic_mode FROM editor_slots WHERE channel_key = $1 ORDER BY scheduled_at`, [CH2]);
  assert.deepEqual(after.rows.map((r) => [r.topic, r.status, r.plan_id === newPlan ? 'new' : 'old']), [
    ['Опублікований зранку', 'shadowed', 'new'],
    ['Виконується зараз', 'running', 'new'],
    ['Ось-ось час', 'planned', 'new'],
    ['Написаний, чекає апруву', 'awaiting_approval', 'new'],
    ['Ще не написаний', 'skipped', 'old'],
    ['Свіжа новина з feed1', 'planned', 'new'],
  ]);
  assert.equal(after.rows[4].error, 'superseded by a new plan');
  assert.equal(after.rows[5].topic_mode, 'live');
});

test('the news watch stays out of a full day and outside its hours, and says why', { skip }, async () => {
  // After the replan above the second channel has 5 active slots = posts_per_day_max.
  const card = (await new EditorChannelsRepository(pool).get(CH2))!;
  const watch = new NewsWatchService({ pool, profile: async () => ({ news_watch: { from_hour: 9 } }), http: { lookup, get } });
  assert.equal((await watch.check(card, at('08:30'))).status, 'outside_hours', 'the owner moved the start to 09:00');
  const r = await watch.check(card, at('12:10'));
  assert.equal(r.status === 'checked' && r.added, null);
  const log = (await pool.query(`SELECT decision, reason, item_url FROM news_watch_log WHERE channel_key = $1 ORDER BY id`, [CH2])).rows;
  assert.deepEqual(log.map((x) => [x.decision, x.item_url]), [['ignored', NEW.link], ['checked', null]]);
  assert.equal(log[0].reason, 'day_full');
  assert.match(log[1].reason, /not added: day_full/);
  const off = new NewsWatchService({ pool, profile: async () => ({ news_watch: { enabled: false } }), http: { lookup, get } });
  assert.equal((await off.check(card, at('12:10'))).status, 'off');
});
