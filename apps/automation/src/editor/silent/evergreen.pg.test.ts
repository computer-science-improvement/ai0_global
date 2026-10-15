/**
 * Spec 037 FR-010 (T10) dry run on a throwaway Postgres: the real runner, role tools (lint, publish guards, the story
 * registry) and critic gate, with scripted LLMs (FakeLlm, no network, no paid call), shadow mode (nothing is sent):
 *   • a slot with two critic rejections is filled by an evergreen post (story kind evergreen, registered, Inbox note);
 *   • a second evergreen in the same channel on the same day is not created;
 *   • an evergreen topic repeated within 30 days is blocked by story_repeat (the slot keeps the main post's reason);
 *   • the MANAGER digest counts the evergreen posts apart.
 * Rerunnable on the same DB (every row it creates is removed). Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AgentLoop } from '../harness/agent-loop';
import { ToolRegistry } from '../harness/tool-registry';
import { PgRunRecorder } from '../harness/run-recorder';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { SkillLibrary } from '../skills/skill-library';
import { buildRoleTools } from '../tools/role-tools';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { EditorPlansRepository } from '../repo/editor-plans.repository';
import { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { EditorRunnerService } from '../roles/editor-runner.service';
import { CriticService } from '../critic/critic.service';
import { CRITIC_SCORE_KEYS, type CriticScores } from '../critic/critic';
import { OwnerInbox } from '../agents/owner-inbox';
import { StoryRegistry } from '../story/story.repository';
import { SqlQuality } from '../manager/quality-digest';
import { makeCard } from '../post/testing/fixtures';
import { EVERGREEN_INBOX_KIND, EvergreenStep } from './evergreen';
import type { SlotFallback } from './fallback-ladder';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt037t10_ever';
const REF = `telegram:${CH}`;
const DAY1 = new Date('2030-06-10T09:00:00Z');   // 12:00 Kyiv
const DAY3 = new Date('2030-06-12T09:00:00Z');
let pool: Pool;
let planId: string;

async function cleanup() {
  await pool.query(`DELETE FROM agent_inbox WHERE ref_type = 'editor_slot' AND ref_id IN (SELECT id::text FROM editor_slots WHERE channel_key = $1)`, [CH]);
  await pool.query(`DELETE FROM editor_stories st WHERE EXISTS (SELECT 1 FROM editor_story_posts sp WHERE sp.story_id = st.id AND sp.resource_ref = $1)`, [REF]);
  await pool.query(`DELETE FROM editor_runs WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1`, [CH]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM content_ledger WHERE resource_ref = $1`, [REF]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  await new EditorChannelsRepository(pool).upsert(makeCard({
    channelKey: CH, mode: 'shadow', brief: 'Розумний дім простими словами', formats: { text: 1 }, hashtags: ['дім'], hashtagMin: 0, hashtagMax: 3,
    quietStartHour: 0, quietEndHour: 0, minGapMinutes: 0, postsPerDayMax: 10,
  }));
  planId = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date, rationale) VALUES ($1, '2030-06-10', 'План') RETURNING id`, [CH])).rows[0].id;
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const all = (n: number) => Object.fromEntries(CRITIC_SCORE_KEYS.map((k) => [k, n])) as CriticScores;
const critique = (verdict: string, scores: CriticScores, notes: string) => ({ calls: [{ name: 'submit_critique', args: { scores, verdict, notes } }] });
const rejectTurn = critique('reject', { ...all(4), grounding: 1 }, 'Цифр немає в джерелі.');
const passTurn = critique('pass', all(5), 'Зрозуміло і корисно.');

const NEWS = (n: number) => ({
  format: 'text', title: `Новина ${n}`, origin: 'external',
  body: [{ type: 'lead', text: `IKEA Dirigera ${n} отримала оновлення` }, { type: 'p', text: `Хаб IKEA Dirigera версії ${n} тепер підтримує нові датчики.` }],
  source: { url: `https://example.com/news/ikea-dirigera-update-${n}`, label: 'Example' },
});
const MATTER = {
  format: 'text', title: 'Що таке Matter', origin: 'external',
  body: [
    { type: 'lead', text: 'Matter простими словами: як Apple Home, Google Home і Amazon Alexa говорять однією мовою' },
    { type: 'p', text: 'Matter — спільний стандарт для розумного дому. Пристрій з логотипом Matter працює з Apple Home, Google Home і Amazon Alexa без окремих застосунків; мережу для датчиків дає Thread.' },
  ],
  source: { url: 'https://csa-iot.org/all-solutions/matter/', label: 'CSA' },
  story: { key: 'matter-explained' },
};
const MATTER_AGAIN = {
  ...MATTER, title: 'Matter: пояснення', source: { url: 'https://developers.home.google.com/matter/overview', label: 'Google' },
  body: [
    { type: 'lead', text: 'Що дає стандарт Matter у звичайній квартирі: Apple Home, Google Home і Amazon Alexa разом' },
    { type: 'p', text: 'Стандарт Matter дозволяє одній лампі чи розетці працювати і з Apple Home, і з Google Home, і з Amazon Alexa, без окремих застосунків для кожної системи. Датчики при цьому спілкуються між собою через мережу Thread, тож не навантажують домашній вайфай.' },
  ],
  story: { key: 'matter-again' },
};

async function slotAt(at: Date): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, attempts)
     VALUES ($1, $2, $3, 'text', 'Новини розумного дому', 'running', 1) RETURNING id`, [planId, CH, at]);
  return rows[0].id;
}

function harness(executor: ConstructorParameters<typeof FakeLlm>[0], critic: ConstructorParameters<typeof FakeLlm>[0], now: Date) {
  const plans = new EditorPlansRepository(pool);
  const memory = new EditorMemoryRepository(pool);
  const skills = new SkillLibrary();
  const registry = new ToolRegistry(buildRoleTools({
    pool, plans, memory, channels: new EditorChannelsRepository(pool),
    publisher: { send: async () => { throw new Error('shadow mode never sends'); } },
    recordPublish: () => {}, now: () => now, stories: new StoryRegistry(pool),
  }));
  const llm = new FakeLlm(executor);
  const loop = new AgentLoop({ llm, recorder: new PgRunRecorder(pool), budget: new FakeBudget(), enabled: () => true });
  const criticService = new CriticService({
    loop: new AgentLoop({ llm: new FakeLlm(critic), recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true }),
    env: () => undefined, now: () => now,
  });
  const step = new EvergreenStep({ pool, plans, perDay: 1, inbox: new OwnerInbox(pool) });
  const runner = new EditorRunnerService({
    loop, registry, skills, plans, memory, env: () => undefined, notify: async () => {}, now: () => now,
    critic: { service: criticService }, fallbackEvergreen: (req) => step.run(req),
  });
  return { runner, plans, llm };
}

const publish = (spec: unknown) => ({ calls: [{ name: 'publish_post', args: { spec } }] });

test('dry run: two critic rejections → an evergreen post fills the slot, registered as an evergreen story', { skip }, async () => {
  const id = await slotAt(DAY1);
  const h = harness([publish(NEWS(1)), publish(NEWS(2)), publish(MATTER)], [rejectTurn, rejectTurn, passTurn], new Date(DAY1.getTime() + 60_000));
  const card = (await new EditorChannelsRepository(pool).get(CH))!;
  await h.runner.runExecutor((await h.plans.getSlot(id))!, card);

  const slot = (await h.plans.getSlot(id))!;
  assert.equal(slot.status, 'shadowed', JSON.stringify(slot.fallback));
  assert.equal((slot.postSpec as any).story.kind, 'evergreen', 'marked by code');
  const f = slot.fallback as SlotFallback;
  assert.deepEqual(f.steps.map((s) => [s.step, s.outcome]), [['initial', 'critic_reject'], ['next_candidate', 'critic_reject'], ['evergreen', 'shadowed']]);
  assert.deepEqual([f.final?.outcome, f.final?.step], ['rescued', 'evergreen']);
  assert.match(h.llm.requests[2].messages.map((m) => String(m.content ?? '')).join('\n'), /Запасний крок \(evergreen\)/);

  // The story registry keeps the topic as an evergreen story (30-day window).
  const { rows: st } = await pool.query(
    `SELECT st.kind, st.story_key, sp.role FROM editor_story_posts sp JOIN editor_stories st ON st.id = sp.story_id WHERE sp.slot_id = $1`, [id]);
  assert.deepEqual(st, [{ kind: 'evergreen', story_key: 'matter-explained', role: 'evergreen' }]);

  // The Inbox still says why the main post did not go out.
  const { rows: inbox } = await pool.query(`SELECT kind, title, body FROM agent_inbox WHERE ref_type = 'editor_slot' AND ref_id = $1`, [id]);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].kind, EVERGREEN_INBOX_KIND);
  assert.match(inbox[0].body, /did not go out: critic_rejected: reject/);
});

test('dry run: a second evergreen in the same channel on the same day is not created', { skip }, async () => {
  const id = await slotAt(new Date(DAY1.getTime() + 3 * 3600_000));
  const now = new Date(DAY1.getTime() + 3 * 3600_000 + 60_000);
  const h = harness([publish(NEWS(3)), publish(NEWS(4))], [rejectTurn, rejectTurn], now);
  const card = (await new EditorChannelsRepository(pool).get(CH))!;
  await h.runner.runExecutor((await h.plans.getSlot(id))!, card);

  const slot = (await h.plans.getSlot(id))!;
  assert.equal(slot.status, 'skipped');
  assert.match(slot.error ?? '', /^critic_rejected: reject/);
  const f = slot.fallback as SlotFallback;
  assert.deepEqual(f.steps.map((s) => [s.step, s.outcome]), [['initial', 'critic_reject'], ['next_candidate', 'critic_reject'], ['evergreen', 'unavailable']]);
  assert.equal(h.llm.requests.length, 2, 'no evergreen run');
});

test('dry run: an evergreen topic repeated within 30 days is blocked by story_repeat', { skip }, async () => {
  const id = await slotAt(DAY3);
  const h = harness(
    [publish(NEWS(5)), publish(NEWS(6)), publish(MATTER_AGAIN), { calls: [{ name: 'skip_slot', args: { reason: 'тема Matter уже була, іншої немає' } }] }],
    [rejectTurn, rejectTurn], new Date(DAY3.getTime() + 60_000));
  const card = (await new EditorChannelsRepository(pool).get(CH))!;
  await h.runner.runExecutor((await h.plans.getSlot(id))!, card);

  const sent = h.llm.requests[3].messages.filter((m) => m.role === 'tool').map((m) => String(m.content ?? '')).join('\n');
  assert.match(sent, /story_repeat/);
  assert.match(sent, /вічнозелена тема вже була/);
  const slot = (await h.plans.getSlot(id))!;
  assert.equal(slot.status, 'skipped');
  assert.match(slot.error ?? '', /^critic_rejected: reject/, 'the main post reason stays on the slot');
  const f = slot.fallback as SlotFallback;
  assert.deepEqual(f.steps.at(-1)?.step, 'evergreen');
  assert.match(f.steps.at(-1)?.reason ?? '', /skipped by agent: тема Matter/);
  assert.deepEqual([f.final?.outcome, f.final?.step], ['skipped', 'evergreen']);
  const { rows } = await pool.query(`SELECT 1 FROM editor_story_posts WHERE slot_id = $1`, [id]);
  assert.equal(rows.length, 0, 'nothing registered');
});

test('digest: the evergreen share of the week is counted apart', { skip }, async () => {
  const q = (await new SqlQuality(pool).digest([REF], new Date(DAY3.getTime() + 3600_000))).get(REF)!;
  assert.deepEqual(q.evergreen, { posts: 1, evergreen: 1, share: 1, over: true });
  assert.ok(q.flags.includes('evergreen_share_high'));
  assert.equal(q.plan?.fallback.rescued, 1);
});
