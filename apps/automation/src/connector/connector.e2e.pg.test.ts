/**
 * Spec 103 WP-C end to end on a throwaway Postgres (prefix p103c_), scripted LLM, fake Telegram, zero network.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createMigratedDb, type FreshDb } from '../editor/sysadmin/testing/fresh-db';
import { FakeLlm, FakeBudget } from '../editor/harness/testing/fakes';
import { AgentLoop } from '../editor/harness/agent-loop';
import { ToolRegistry } from '../editor/harness/tool-registry';
import { PgRunRecorder } from '../editor/harness/run-recorder';
import { ReadonlyQueryService } from '../editor/db/readonly-query.service';
import { buildReadTools } from '../editor/tools/read-tools';
import { buildComposeTools } from '../editor/tools/compose-tools';
import { EditorChatRepository } from '../editor/repo/editor-chat.repository';
import { DraftsService } from '../editor/chat/drafts.service';
import { buildComposerTools } from '../editor/chat/composer-tools';
import { EditorChatService } from '../editor/chat/editor-chat.service';
import { ConnectorChatService } from './chat/connector-chat.service';
import { ConnectorPostsRepository } from './posts/connector-posts.repository';
import { PgConnectorQueries } from './queries/connector-queries';
import { SPEC, cleanChannel, harness, seedChannel } from './testing/pg-harness';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const NOW = new Date('2030-03-04T07:00:00Z'); // Monday 09:00 Kyiv (UTC+2)
let db: FreshDb;
let pool: Pool;

before(async () => {
  if (!url) return;
  db = await createMigratedDb(url, 'p103c_e2e');
  pool = db.pool;
});
after(async () => { if (db) await db.drop(); });

const noLlm = new FakeLlm([]);

test('prepare_post → the approval publisher sends the stored render at its time (live mode: approved at once)', { skip }, async () => {
  const CH = '@p103c_prepare';
  await seedChannel(pool, CH, 'live');
  const clock = { now: NOW };
  const h = harness(pool, clock, noLlm);
  const r: any = await h.posts.prepare({ channel: CH, at: '2030-03-04 15:00', post: SPEC });
  assert.equal(r.status, 'approved');
  assert.equal(h.sent.length, 0, 'nothing is sent at prepare time');

  const row = (await pool.query(`SELECT status, created_via, locked_by, locked_at, owner_edited, approved_by, approved_at, render_messages, topic_mode FROM editor_slots WHERE id = $1`, [r.post_id])).rows[0];
  assert.deepEqual([row.status, row.created_via, row.locked_by, row.owner_edited, row.approved_by, row.topic_mode], ['approved', 'connector', 'connector', true, 'owner', 'fixed']);
  assert.ok(row.locked_at && row.approved_at);
  const stored = row.render_messages.messages;

  clock.now = new Date('2030-03-04T12:59:00Z');
  assert.deepEqual(await h.approvalPublisher.publishDue(clock.now), { published: 0, skipped: 0, failed: 0 }, 'not before its time');
  clock.now = new Date('2030-03-04T13:01:00Z');
  const out = await h.approvalPublisher.publishDue(clock.now);
  assert.equal(out.published, 1, JSON.stringify(out));
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].messages, stored, 'exactly the stored render goes out');
  assert.equal((await pool.query(`SELECT status FROM editor_slots WHERE id = $1`, [r.post_id])).rows[0].status, 'published');
  await cleanChannel(pool, CH);
});

test('prepare_post in approve mode waits; approve_post uses the approval service; the executor never claims it', { skip }, async () => {
  const CH = '@p103c_wait';
  await seedChannel(pool, CH, 'approve');
  const clock = { now: NOW };
  const h = harness(pool, clock, noLlm);
  const r: any = await h.posts.prepare({ channel: CH, at: '2030-03-04 15:00', post: SPEC });
  assert.equal(r.status, 'awaiting_approval');
  clock.now = new Date('2030-03-04T13:30:00Z');
  const claimed = (await h.plans.claimDue(clock.now, 50)).filter((s) => s.channelKey === CH);
  assert.equal(claimed.length, 0, 'waiting posts are not claimed by the executor');
  assert.equal((await h.approvalPublisher.publishDue(clock.now)).published, 0, 'unapproved posts are not published');
  clock.now = NOW;
  await h.posts.approve({ postId: r.post_id });
  assert.deepEqual(h.approvals.approved, [r.post_id]);
  clock.now = new Date('2030-03-04T13:30:00Z');
  assert.equal((await h.plans.claimDue(clock.now, 50)).filter((s) => s.channelKey === CH).length, 0, 'approved posts are not claimed by the executor either');
  assert.equal((await h.approvalPublisher.publishDue(clock.now)).published, 1);
  await cleanChannel(pool, CH);
});

test('plan_post → the executor writes it from the brief', { skip }, async () => {
  const CH = '@p103c_plan';
  await seedChannel(pool, CH, 'live');
  const clock = { now: NOW };
  const spec = { ...SPEC, title: 'Ring Nebula by Webb' };
  const llm = new FakeLlm([{ calls: [{ name: 'lint_post', args: { spec } }] }, { calls: [{ name: 'publish_post', args: { spec } }] }]);
  const h = harness(pool, clock, llm);
  const r: any = await h.posts.plan({ channel: CH, at: '2030-03-04 15:00', topic: 'The Ring Nebula in infrared', angle: 'what the shells are', notes: 'mention Webb' });
  const slot = (await h.plans.getSlot(r.post_id))!;
  assert.deepEqual([slot.status, slot.kind, slot.topicMode, slot.createdVia, slot.lockedBy], ['planned', 'content', undefined, 'connector', 'connector'], 'topic_mode fixed reads back as no live mode');

  clock.now = new Date('2030-03-04T13:01:00Z');
  const [claimed] = (await h.plans.claimDue(clock.now, 50)).filter((s) => s.channelKey === CH);
  assert.equal(claimed.id, r.post_id);
  const card = (await h.channels.get(CH))!;
  const exec = await h.runner.runExecutor(claimed, card);
  assert.equal(exec.terminalTool, 'publish_post', JSON.stringify(exec));
  const prompt = JSON.stringify(llm.requests[0].messages);
  assert.match(prompt, /The Ring Nebula in infrared/);
  assert.match(prompt, /what the shells are/);
  assert.match(prompt, /mention Webb/);
  assert.equal(h.sent.length, 1);
  assert.equal((await h.plans.getSlot(r.post_id))!.status, 'published');
  await cleanChannel(pool, CH);
});

test('talk_to_agent: a scripted LLM that tries publish_draft and schedule_draft is refused both times, nothing is scheduled or sent', { skip }, async () => {
  const CH = '@p103c_talk';
  await seedChannel(pool, CH, 'live');
  const clock = { now: NOW };
  const sent: unknown[] = [];
  const repo = new EditorChatRepository(pool);
  const drafts = new DraftsService({
    pool, repo, channels: new (await import('../editor/repo/editor-channels.repository')).EditorChannelsRepository(pool),
    plans: new (await import('../editor/repo/editor-plans.repository')).EditorPlansRepository(pool),
    publisher: { send: async (_k: string, m: unknown[]) => { sent.push(m); return { messageIds: [1] }; } }, recordPublish: () => {}, isPaused: () => false,
    notify: async () => {}, now: () => clock.now,
  });
  const toolResults: string[] = [];
  const llm = new FakeLlm([
    { calls: [{ name: 'save_draft', args: { channel: CH, spec: SPEC } }] },
    { calls: [{ name: 'schedule_draft', args: { draft_id: '00000000-0000-0000-0000-000000000000', at: '2030-03-05 19:00' } }] },
    { calls: [{ name: 'publish_draft', args: { draft_id: '00000000-0000-0000-0000-000000000000' } }] },
    { text: 'I could not schedule or publish: this chat only proposes.' },
  ]);
  const { SkillLibrary } = await import('../editor/skills/skill-library');
  const skills = new SkillLibrary();
  const registry = new ToolRegistry([
    ...buildReadTools({ pool, readonly: new ReadonlyQueryService(pool), skills }),
    ...buildComposeTools(),
    ...buildComposerTools({ drafts, repo }),
  ]);
  const loop = new AgentLoop({ llm, recorder: new PgRunRecorder(pool), budget: new FakeBudget(), enabled: () => true });
  const chat = new EditorChatService({
    repo, drafts, memory: new (await import('../editor/repo/editor-memory.repository')).EditorMemoryRepository(pool), loop, registry, skills,
    env: () => undefined, enabled: () => true, now: () => clock.now,
  });
  const svc = new ConnectorChatService({ chat: chat as any, agents: { handles: async () => [], byId: async () => new Map() } });

  const r: any = await svc.talk({ message: `Write a post for ${CH} about the Ring Nebula, schedule it tomorrow at 19:00 and publish it now`, waitSeconds: 30 });
  assert.equal(r.running, false);
  assert.equal((await pool.query(`SELECT created_via FROM editor_chats WHERE id = $1`, [r.chat_id])).rows[0].created_via, 'connector');
  for (const m of llm.requests.flatMap((q) => q.messages)) if ((m as any).role === 'tool') toolResults.push(String((m as any).content));
  assert.ok(toolResults.some((t) => /schedule_draft|request|intent|ask/i.test(t)), `schedule_draft was refused: ${toolResults.join(' | ')}`);
  assert.equal(sent.length, 0, 'nothing was sent');
  const slots = await pool.query(`SELECT count(*)::int AS n FROM editor_slots WHERE channel_key = $1`, [CH]);
  assert.equal(slots.rows[0].n, 0, 'nothing was scheduled');
  const dr = await pool.query(`SELECT status FROM editor_drafts WHERE channel_key = $1`, [CH]);
  assert.ok(dr.rows.every((x) => x.status === 'draft'), JSON.stringify(dr.rows));
  await cleanChannel(pool, CH);
});

test('connector posts repository: edit guards, cancel, and the queries read what was written', { skip }, async () => {
  const CH = '@p103c_repo';
  await seedChannel(pool, CH, 'approve');
  const clock = { now: NOW };
  const h = harness(pool, clock, noLlm);
  const repo = new ConnectorPostsRepository(pool);
  const a: any = await h.posts.prepare({ channel: CH, at: '2030-03-04 15:00', post: SPEC });
  const p: any = await h.posts.plan({ channel: CH, at: '2030-03-04 17:00', topic: 'Another topic here' });

  // within the lock window nothing is patched
  const late = await repo.patchWritten(a.post_id, { at: new Date('2030-03-04T14:00:00Z') }, new Date('2030-03-04T13:30:00Z'));
  assert.equal(late, null);
  const moved = await repo.patchPlanned(p.post_id, { topic: 'New topic here', at: new Date('2030-03-04T16:30:00Z') }, NOW);
  assert.equal(moved?.topic, 'New topic here');

  const sched = new PgConnectorQueries(pool);
  const { rows } = await sched.schedule({ channel: CH, from: NOW, to: new Date('2030-03-05T00:00:00Z'), includeClosed: false, limit: 10 });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.createdVia === 'connector' && x.lockedBy === 'connector'));
  assert.equal((await sched.approvals(CH, NOW)).length, 1);

  await h.posts.cancel({ postId: p.post_id, reason: 'test' });
  const closed = await sched.schedule({ channel: CH, from: NOW, to: new Date('2030-03-05T00:00:00Z'), includeClosed: true, limit: 10 });
  assert.equal(closed.rows.find((x) => x.id === p.post_id)?.status, 'skipped');
  const logs = await sched.logs({ channel: CH, since: new Date(NOW.getTime() - 86_400_000), until: new Date('2031-01-01T00:00:00Z'), level: null, kinds: null, limit: 20 });
  assert.ok(Array.isArray(logs));
  await cleanChannel(pool, CH);
});
