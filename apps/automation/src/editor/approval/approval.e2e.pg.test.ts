/**
 * Spec 031 T2 end to end against a real throwaway Postgres, a scripted LLM and
 * fake publishers (zero network). The safety invariant: no post of a resource
 * in approval mode reaches Telegram or a platform without `approved_at`.
 * Skipped unless EDITOR_PG_TEST_URL is set.
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
import { buildPlatformTools } from '../platform/platform-tools';
import { PlatformPostsRepository } from '../platform/platform-posts.repository';
import type { PublishPlatformDeps } from '../platform/publish-platform';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { EditorPlansRepository } from '../repo/editor-plans.repository';
import { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { EditorRunnerService } from '../roles/editor-runner.service';
import { EditorScheduler } from '../editor.scheduler';
import type { TgMessage } from '../post/render-telegram';
import { ApprovalsRepository } from './approvals.repository';
import { ApprovalPublisher } from './approval-publisher';
import { ApprovalUpkeep } from './approval-upkeep';
import { syncAgentsFor } from './pg-test-agents';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@e2e_approval';
const IG = 'instagram:e2e-approval-ig';
// Wed 2030-03-06 20:05 Kyiv (UTC+2): the evening batch for Thursday.
const EVENING = new Date('2030-03-06T18:05:00Z');
const SLOT_AT = new Date('2030-03-07T08:00:00Z'); // Thu 10:00 Kyiv
let pool: Pool;

async function cleanup() {
  await pool.query(`DELETE FROM editor_runs WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1`, [CH]);
  await pool.query(`DELETE FROM platform_posts WHERE resource_ref = $1`, [IG]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  await pool.query(
    `INSERT INTO editor_channels (channel_key, mode, title, brief, formats, hashtags, posts_per_day_min, posts_per_day_max, plan_hour)
     VALUES ($1, 'approve', 'Космос щодня', 'Короткі пояснення космічних знімків', '{"photo":1,"text":0.5}', '{космос,nasa}', 1, 3, 0)`, [CH]);
  await syncAgentsFor(pool, [CH]);
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const SPEC = {
  format: 'photo', title: 'Туманність Кільце від Webb', origin: 'external',
  body: [
    { type: 'lead', text: 'Webb показав туманність Кільце в інфрачервоному світлі' },
    { type: 'p', text: 'Оболонки газу навколо білого карлика — це рештки зорі, схожої на Сонце. Їм кілька тисяч років.' },
  ],
  media: [{ url: 'https://images-assets.nasa.gov/ring.jpg' }],
  hashtags: ['космос'],
  source: { url: 'https://www.nasa.gov/ring-nebula', label: 'NASA' },
};

const PLATFORM_SPEC = {
  format: 'ig_photo', title: 'Туманність Кільце', caption: 'Туманність Кільце очима Webb: газ, який зоря скинула тисячі років тому.',
  hashtags: ['космос'], media: [{ url: 'https://images-assets.nasa.gov/ring.jpg', kind: 'image' }],
};

/** Everything an approval-mode channel needs, with fakes for Telegram and Instagram. */
function harness(turns: ConstructorParameters<typeof FakeLlm>[0], clock: { now: Date }) {
  const now = () => clock.now;
  const channels = new EditorChannelsRepository(pool);
  const plans = new EditorPlansRepository(pool);
  const memory = new EditorMemoryRepository(pool);
  const repo = new ApprovalsRepository(pool);
  const tgSent: Array<{ channelKey: string; messages: TgMessage[] }> = [];
  const igSent: Array<[string, unknown]> = [];
  const notices: string[] = [];
  let paused = false;
  const publisher = {
    send: async (channelKey: string, messages: TgMessage[]) => {
      if (paused) throw new Error(`channel ${channelKey} has publish_paused=true`);
      tgSent.push({ channelKey, messages });
      return { messageIds: messages.map((_, i) => 9000 + tgSent.length * 10 + i) };
    },
  };
  const platformDeps: PublishPlatformDeps = {
    posts: new PlatformPostsRepository(pool),
    publisher: { publish: async (ref, r) => { igSent.push([ref, r]); return { externalId: `ig-${igSent.length}`, url: null, warnings: [] }; } },
    health: async () => null,
    pool,
    now,
  };
  const skills = new SkillLibrary();
  const registry = new ToolRegistry([
    ...buildReadTools({ pool, readonly: new ReadonlyQueryService(pool), skills }),
    ...buildComposeTools(),
    ...buildRoleTools({ pool, plans, memory, channels, publisher, recordPublish: () => {}, now }),
    ...buildPlatformTools({ pool, publish: platformDeps, plans }),
  ]);
  const llm = new FakeLlm(turns);
  const loop = new AgentLoop({
    llm, recorder: new PgRunRecorder(pool), enabled: () => true,
    budget: new BudgetService(pool, { globalDailyUsd: 100, channelDailyUsd: 100 }),
  });
  const runner = new EditorRunnerService({ loop, registry, skills, plans, memory, env: () => undefined, notify: async () => {}, now });
  const mode = async (c: { mode: any }) => c.mode;
  const approvalPublisher = new ApprovalPublisher({
    repo, plans, card: (k) => channels.get(k), mode,
    telegram: { plans, publisher, recordPublish: () => {} },
    platform: platformDeps,
    notice: async (_s, title) => { notices.push(title); },
  });
  const upkeep = new ApprovalUpkeep({ repo, publisher: approvalPublisher, card: (k) => channels.get(k), mode });
  const scheduler = new EditorScheduler({
    pool, channels: { listActive: async () => (await channels.listActive()).filter((c) => c.channelKey === CH) },
    plans, runner, enabled: () => true, notify: async () => {},
    approval: { mode, tick: (t) => upkeep.tick(t) },
  });
  return {
    channels, plans, repo, runner, scheduler, upkeep, llm, tgSent, igSent, notices,
    pause: (v: boolean) => { paused = v; },
  };
}

/** The invariant, asked of the database: nothing of an approval-mode channel went out unapproved. */
async function assertNoUnapprovedPublish(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT s.id FROM editor_slots s WHERE s.channel_key = $1 AND s.status = 'published' AND s.approved_at IS NULL
     UNION ALL
     SELECT s.id FROM published_posts p JOIN editor_slots s ON s.id = p.editor_slot_id WHERE p.channel_id = $1 AND s.approved_at IS NULL
     UNION ALL
     SELECT s.id FROM platform_posts pp JOIN editor_slots s ON s.id = pp.slot_id WHERE pp.resource_ref = $2 AND pp.status = 'published' AND s.approved_at IS NULL`,
    [CH, IG]);
  assert.deepEqual(rows, [], 'a post went out without approved_at');
}

test('Telegram: the evening batch is written ahead, waits, never goes out unapproved; approved → sent exactly as previewed', { skip }, async () => {
  const clock = { now: EVENING };
  // Today already has its plan; the evening tick plans and writes Thursday.
  await pool.query(`INSERT INTO editor_plans (channel_key, plan_date, rationale) VALUES ($1, '2030-03-06', 'today')`, [CH]);
  const h = harness([
    // planner (Thursday)
    { calls: [{ name: 'submit_plan', args: { rationale: 'Один пост у ранковий пік.', slots: [{ time: '10:00', format: 'photo', topic: 'Знімок туманності Кільце від Webb', source_hints: ['https://www.nasa.gov/ring-nebula'] }] } }] },
    // executor
    { calls: [{ name: 'lint_post', args: { spec: SPEC } }] },
    { calls: [{ name: 'publish_post', args: { spec: SPEC } }] },
  ], clock);

  await h.scheduler.tick(EVENING);
  const plan = await h.plans.getActivePlan(CH, '2030-03-07');
  assert.ok(plan, 'the next day is planned at 20:00');
  const [slot] = await h.plans.listSlots(CH, plan!.id);
  assert.equal(slot.scheduledAt.toISOString(), SLOT_AT.toISOString());
  assert.equal(slot.status, 'awaiting_approval', `written ahead in the same tick: ${slot.status} ${slot.error ?? ''}`);
  assert.equal(slot.approvedAt, undefined);
  assert.equal(h.tgSent.length, 0, 'writing never sends');
  const stored = slot.renderMessages!;
  assert.equal(stored.kind, 'telegram');

  // At (and after) its time, an unapproved post is not published.
  clock.now = new Date(SLOT_AT.getTime() + 60_000);
  await h.upkeep.tick(clock.now);
  await h.scheduler.tick(clock.now);
  assert.equal(h.tgSent.length, 0, 'no approval, no send');
  assert.equal((await h.plans.getSlot(slot.id))!.status, 'awaiting_approval');
  await assertNoUnapprovedPublish();

  // The owner approves (one minute late: under 2 h, so it goes out now).
  const approved = await h.repo.approve(slot.id);
  assert.ok(approved?.approvedAt);
  assert.equal(await h.repo.approve(slot.id), null, 'single-flight: the second approve loses');
  await h.upkeep.tick(clock.now);
  assert.equal(h.tgSent.length, 1);
  assert.deepEqual(h.tgSent[0].messages, (stored as any).messages, 'the sent payload is exactly the stored preview');
  const after = (await h.plans.getSlot(slot.id))!;
  assert.equal(after.status, 'published');
  assert.ok(after.publishedPostId);
  const pub = await pool.query(`SELECT editor_slot_id, source_url FROM published_posts WHERE channel_id = $1`, [CH]);
  assert.deepEqual(pub.rows, [{ editor_slot_id: slot.id, source_url: 'https://www.nasa.gov/ring-nebula' }]);
  await h.upkeep.tick(new Date(clock.now.getTime() + 60_000));
  assert.equal(h.tgSent.length, 1, 'published once');
  await assertNoUnapprovedPublish();
});

test('platform: a waiting Instagram post is never sent unapproved; approved → the stored render goes out', { skip }, async () => {
  const clock = { now: new Date('2030-03-07T10:00:00Z') }; // Thu 12:00 Kyiv
  const plan = (await pool.query(`SELECT id FROM editor_plans WHERE channel_key = $1 AND plan_date = '2030-03-07' AND status = 'active'`, [CH])).rows[0].id;
  const at = new Date('2030-03-07T12:00:00Z');
  const id = (await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, resource_ref) VALUES ($1, $2, $3, 'ig_photo', 'Туманність Кільце', $4) RETURNING id`,
    [plan, CH, at, IG])).rows[0].id as string;
  const h = harness([
    { calls: [{ name: 'lint_platform_post', args: { spec: PLATFORM_SPEC } }] },
    { calls: [{ name: 'publish_platform_post', args: { spec: PLATFORM_SPEC } }] },
  ], clock);
  const claimed = (await h.plans.claimSlot(id))!;
  const card = (await h.channels.get(CH))!;
  const res = await h.runner.runExecutor(claimed, card);
  assert.equal(res.terminalTool, 'publish_platform_post', JSON.stringify(res));
  const slot = (await h.plans.getSlot(id))!;
  assert.equal(slot.status, 'awaiting_approval');
  assert.ok(slot.platformPostId);
  const row = await pool.query(`SELECT status FROM platform_posts WHERE id = $1`, [slot.platformPostId]);
  assert.equal(row.rows[0].status, 'awaiting_approval');
  assert.equal(h.igSent.length, 0);

  clock.now = new Date(at.getTime() + 60_000);
  await h.upkeep.tick(clock.now);
  assert.equal(h.igSent.length, 0, 'no approval, no API call');
  await assertNoUnapprovedPublish();

  assert.ok(await h.repo.approve(id));
  await h.upkeep.tick(clock.now);
  assert.equal(h.igSent.length, 1);
  assert.deepEqual(h.igSent[0], [IG, (slot.renderMessages as any).rendered], 'exactly the approved render');
  assert.equal((await h.plans.getSlot(id))!.status, 'published');
  const done = await pool.query(`SELECT status, external_id FROM platform_posts WHERE id = $1`, [slot.platformPostId]);
  assert.deepEqual(done.rows[0], { status: 'published', external_id: 'ig-1' });
  await assertNoUnapprovedPublish();
});

/** A written post straight in the table (the executor path is covered above). */
async function waitingSlot(o: { at: Date; source?: string; status?: string; freshness?: Date | null; topic?: string }): Promise<string> {
  const plan = (await pool.query(`SELECT id FROM editor_plans WHERE channel_key = $1 AND status = 'active' ORDER BY plan_date DESC LIMIT 1`, [CH])).rows[0].id;
  const spec = { ...SPEC, title: o.topic ?? 'Пост', source: { url: o.source ?? `https://src.example/${Math.random()}`, label: 'Src' } };
  const messages = [{ method: 'sendMessage', text: `<b>${o.topic ?? 'Пост'}</b> ${Math.random()}`, preview: null, buttons: [] }];
  const { rows } = await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, post_spec, rendered_preview, render_messages, freshness_deadline, approved_at, approved_by)
     VALUES ($1, $2, $3, 'text', $4, $5, $6, $7, $8, $9, CASE WHEN $5 = 'approved' THEN now() END, CASE WHEN $5 = 'approved' THEN 'owner' END) RETURNING id`,
    [plan, CH, o.at, o.topic ?? 'Пост', o.status ?? 'awaiting_approval', JSON.stringify(spec), messages[0].text,
      JSON.stringify({ kind: 'telegram', messages, primary: 0 }), o.freshness ?? null]);
  return rows[0].id;
}

test('expiry: unapproved past the hold window (or its freshness deadline) → expired, never published', { skip }, async () => {
  const clock = { now: new Date('2030-03-08T08:00:00Z') };
  const h = harness([], clock);
  const old = await waitingSlot({ at: new Date('2030-03-08T01:00:00Z'), topic: 'Старий' });        // 7 h ago, hold 6 h
  const fresh = await waitingSlot({ at: new Date('2030-03-08T07:00:00Z'), topic: 'Новина', freshness: new Date('2030-03-08T07:30:00Z') });
  const keep = await waitingSlot({ at: new Date('2030-03-08T07:30:00Z'), topic: 'Ще чекає' });
  await h.upkeep.tick(clock.now);
  assert.equal((await h.plans.getSlot(old))!.status, 'expired');
  assert.equal((await h.plans.getSlot(fresh))!.status, 'expired', 'past its freshness deadline');
  assert.equal((await h.plans.getSlot(keep))!.status, 'awaiting_approval', 'within the hold window');
  assert.equal(await h.repo.approve(old), null, 'an expired post cannot be approved');
  await h.upkeep.tick(new Date(clock.now.getTime() + 3600_000));
  assert.equal(h.tgSent.length, 0);
  await pool.query(`UPDATE editor_slots SET status = 'skipped' WHERE id = $1`, [keep]);
});

test('dedup after approval: the source went out while the post waited → skipped, the owner is told', { skip }, async () => {
  const clock = { now: new Date('2030-03-09T08:00:00Z') };
  const h = harness([], clock);
  const src = 'https://src.example/dup';
  const id = await waitingSlot({ at: new Date('2030-03-09T07:59:00Z'), source: src, status: 'approved', topic: 'Дубль' });
  await pool.query(`INSERT INTO published_posts (channel_id, message_id, source_url, title) VALUES ($1, 777, $2, 'Інший шлях')`, [CH, src]);
  await h.upkeep.tick(clock.now);
  const s = (await h.plans.getSlot(id))!;
  assert.equal(s.status, 'skipped');
  assert.equal(s.error, 'dedup_after_approval');
  assert.equal(h.tgSent.length, 0);
  assert.equal(h.notices.length, 1);
});

test('mode switched away from approval, or a paused channel: an approved post is not sent', { skip }, async () => {
  const clock = { now: new Date('2030-03-10T08:00:00Z') };
  const h = harness([], clock);
  const paused = await waitingSlot({ at: new Date('2030-03-10T07:59:00Z'), status: 'approved', topic: 'Пауза' });
  h.pause(true);
  await h.upkeep.tick(clock.now);
  const p = (await h.plans.getSlot(paused))!;
  assert.equal(p.status, 'failed', 'a paused channel follows the normal failed-slot path');
  assert.match(p.error!, /publish_paused/);
  h.pause(false);

  const switched = await waitingSlot({ at: new Date('2030-03-10T07:59:00Z'), status: 'approved', topic: 'Режим' });
  await pool.query(`UPDATE editor_channels SET mode = 'shadow' WHERE channel_key = $1`, [CH]); // any switch path
  await h.upkeep.tick(clock.now);
  assert.deepEqual([(await h.plans.getSlot(switched))!.status, (await h.plans.getSlot(switched))!.error], ['skipped', 'mode_changed']);
  assert.equal(h.tgSent.length, 0);
  await pool.query(`UPDATE editor_channels SET mode = 'approve' WHERE channel_key = $1`, [CH]);
  await assertNoUnapprovedPublish();
});

test('a replan drops posts still waiting in the old plan; approved ones stay', { skip }, async () => {
  const h = harness([], { now: new Date('2030-03-11T05:00:00Z') });
  await pool.query(`INSERT INTO editor_plans (channel_key, plan_date, rationale) VALUES ($1, '2030-03-12', 'old')`, [CH]);
  const waiting = await waitingSlot({ at: new Date('2030-03-12T08:00:00Z'), topic: 'Старий план' });
  const approved = await waitingSlot({ at: new Date('2030-03-12T09:00:00Z'), status: 'approved', topic: 'Апрувнутий' });
  await h.plans.createPlan(CH, '2030-03-12', 'новий план', null, []);
  const w = (await h.plans.getSlot(waiting))!;
  assert.deepEqual([w.status, w.error], ['skipped', 'superseded by a new plan']);
  assert.equal((await h.plans.getSlot(approved))!.status, 'approved');
  await pool.query(`UPDATE editor_slots SET status = 'skipped' WHERE id = $1`, [approved]);
});
