/**
 * Spec 103 §8 rows 7, 8, 9 and 14 (approval lane) against a throwaway Postgres (EDITOR_PG_TEST_URL, prefix p103b_):
 * the mode sweep, a reject, a bulk approve leave a locked post alone; the approval publisher still re-checks the channel mode
 * at send time (an off / shadow channel never sends a locked approved post), the pause, dedup, similarity and the daily cap,
 * and `expire` still closes a locked post with its usual reason.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalPublisher } from '../approval/approval-publisher';
import { ApprovalUpkeep } from '../approval/approval-upkeep';
import { ApprovalsRepository } from '../approval/approvals.repository';
import { ApprovalsService } from '../approval/approvals.service';
import { AutonomyService } from '../approval/autonomy';
import { syncAgentsFor } from '../approval/pg-test-agents';
import { PAUSED_ERROR } from '../pauses/resource-pauses';
import { dropWaitingPosts, EditorChannelsRepository } from '../repo/editor-channels.repository';
import { EditorPlansRepository } from '../repo/editor-plans.repository';
import { LockFx, SHAPES, NOW, HOUR } from './testing/lock-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let fx: LockFx;
let plans: EditorPlansRepository;
let channels: EditorChannelsRepository;
let repo: ApprovalsRepository;

before(async () => {
  if (!url) return;
  fx = await LockFx.create(url, 'rows79');
  plans = new EditorPlansRepository(fx.pool, () => NOW);
  channels = new EditorChannelsRepository(fx.pool);
  repo = new ApprovalsRepository(fx.pool);
});
after(async () => { if (url) await fx.drop(); });

const later = (h: number) => new Date(NOW.getTime() + h * HOUR);
const earlier = (h: number) => new Date(NOW.getTime() - h * HOUR);

/** An approval channel with a synced orchestrator (the owner's cards read it). */
async function approvalChannel(mode: 'approve' | 'live' | 'shadow' | 'off' = 'approve') {
  const card = await fx.channel({ mode });
  await syncAgentsFor(fx.pool, [card.channelKey]);
  return card;
}

function publisher(o: { paused?: boolean; dedup?: boolean; sent?: string[] } = {}) {
  const sent = o.sent ?? [];
  const mode = async (c: { mode: any }) => c.mode;
  // `dedup`: the ledger says the post's source went out while it waited (the ledger itself is covered by its own tests).
  const r = o.dedup ? Object.assign(Object.create(repo), { publishedSource: async () => true }) as ApprovalsRepository : repo;
  const pub = new ApprovalPublisher({
    repo: r, plans, card: (k) => channels.get(k), mode,
    telegram: { plans, publisher: { send: async (k: string, m: any[]) => { sent.push(k); return { messageIds: m.map((_, i) => 700 + i) }; } }, recordPublish: () => {} },
    platform: {} as any,
    ...(o.paused ? { paused: async () => true } : {}),
  });
  return { pub, sent, upkeep: new ApprovalUpkeep({ repo, publisher: pub, card: (k) => channels.get(k), mode }) };
}

const service = () => new ApprovalsService({ repo, card: (k) => channels.get(k), now: () => NOW });

for (const sh of SHAPES) {
  test(`row 7: dropWaitingPosts (mode sweep) skips waiting and approved posts as mode_changed only when unlocked (${sh.name})`, { skip }, async () => {
    const card = await approvalChannel();
    const a = await fx.slot(card.channelKey, { at: later(5), status: 'awaiting_approval', lockedBy: sh.lockedBy });
    const b = await fx.slot(card.channelKey, { at: later(6), status: 'approved', lockedBy: sh.lockedBy });
    assert.equal(await dropWaitingPosts(fx.pool, card.channelKey), sh.lockedBy ? 0 : 2);
    assert.deepEqual(await fx.state(a), [sh.lockedBy ? 'awaiting_approval' : 'skipped', sh.lockedBy ? null : 'mode_changed']);
    assert.deepEqual(await fx.state(b), [sh.lockedBy ? 'approved' : 'skipped', sh.lockedBy ? null : 'mode_changed']);
  });

  test(`row 7: the approval tick on a channel switched to shadow drops unlocked posts; a locked approved post is skipped at send time, never sent (${sh.name})`, { skip }, async () => {
    const card = await approvalChannel('shadow');
    const waiting = await fx.slot(card.channelKey, { at: later(5), status: 'awaiting_approval', lockedBy: sh.lockedBy });
    const due = await fx.slot(card.channelKey, { at: earlier(1), status: 'approved', lockedBy: sh.lockedBy });
    const h = publisher();
    await h.upkeep.tick(NOW);
    assert.equal(h.sent.length, 0, 'nothing is sent on a shadow channel');
    assert.deepEqual(await fx.state(waiting), [sh.lockedBy ? 'awaiting_approval' : 'skipped', sh.lockedBy ? null : 'mode_changed']);
    // The due approved post is closed with the usual reason either way (the sweep or the publisher's own mode check).
    assert.deepEqual(await fx.state(due), ['skipped', 'mode_changed']);
  });

  test(`row 7: the approval publisher refuses a locked approved post on an off channel (${sh.name})`, { skip }, async () => {
    const card = await approvalChannel('off');
    const id = await fx.slot(card.channelKey, { at: earlier(1), status: 'approved', lockedBy: sh.lockedBy });
    const h = publisher();
    assert.deepEqual(await h.pub.publishDue(NOW), { published: 0, skipped: 1, failed: 0 });
    assert.equal(h.sent.length, 0);
    assert.deepEqual(await fx.state(id), ['skipped', 'mode_changed']);
  });

  test(`row 8: rejecting a waiting post writes a replacement slot only for an unlocked post (${sh.name})`, { skip }, async () => {
    const card = await approvalChannel();
    const id = await fx.slot(card.channelKey, { at: later(10), status: 'awaiting_approval', lockedBy: sh.lockedBy, topic: 'draft' });
    const out = await service().reject(id, { reason: 'not today' });
    assert.deepEqual(await fx.state(id), ['skipped', 'rejected by owner']);
    if (sh.lockedBy) {
      assert.equal(out.replacementId, null);
      assert.equal((await fx.pool.query(`SELECT 1 FROM editor_slots WHERE replaces_slot_id = $1`, [id])).rowCount, 0);
    } else {
      assert.ok(out.replacementId);
      const rep = await fx.row(out.replacementId!);
      assert.equal(rep.status, 'planned');
      assert.equal(rep.replaces_slot_id, id);
      assert.equal(rep.locked_by, null, 'the agent\'s replacement is the agent\'s');
    }
    // The repository guard alone is enough too, for a locked post.
    if (sh.lockedBy) assert.equal(await repo.insertReplacement((await plans.getSlot(id))!, 'note'), null);
  });

  test(`row 9: a bulk approve skips a locked waiting post and approves an unlocked one (${sh.name})`, { skip }, async () => {
    const card = await approvalChannel();
    const id = await fx.slot(card.channelKey, { at: later(10), status: 'awaiting_approval', lockedBy: sh.lockedBy });
    const out = await service().bulk({ channel: card.channelKey });
    assert.equal(out.approved, sh.lockedBy ? 0 : 1);
    assert.equal(out.skippedLocked, sh.lockedBy ? 1 : 0, 'a locked post is counted, not silently dropped');
    assert.equal((await fx.row(id)).status, sh.lockedBy ? 'awaiting_approval' : 'approved');
  });

  test(`row 9 (D3): approve_waiting on the autonomy switch never approves a locked post and reports it (${sh.name})`, { skip }, async () => {
    const card = await approvalChannel();
    const id = await fx.slot(card.channelKey, { at: later(10), status: 'awaiting_approval', lockedBy: sh.lockedBy });
    const svc = service();
    const autonomy = new AutonomyService({
      stats: { report: async () => ({}) as any },
      card: (k) => channels.get(k),
      mode: async () => 'approve',
      setMode: async () => {},
      waiting: (k) => repo.list({ status: ['awaiting_approval'], channel: k }),
      approve: async (i) => { await svc.approve(i); },
      now: () => NOW,
    });
    const out = await autonomy.switchMode({ channel: card.channelKey, mode: 'live', approve_waiting: true });
    assert.equal(out.approved, sh.lockedBy ? 0 : 1);
    assert.equal(out.skippedWithWarnings, sh.lockedBy ? 1 : 0);
    assert.equal(out.leftWaiting, sh.lockedBy ? 1 : 0);
    assert.equal((await fx.row(id)).status, sh.lockedBy ? 'awaiting_approval' : 'approved');
  });
}

test('row 8: a connector post can still be rejected by the owner (the lock protects against the automation, not the owner)', { skip }, async () => {
  const card = await approvalChannel();
  const id = await fx.slot(card.channelKey, { at: later(10), status: 'awaiting_approval', lockedBy: 'connector' });
  const out = await service().reject(id, {});
  assert.equal(out.card.status, 'skipped');
});

test('row 14: the approval publisher sends a locked approved post at its time (the stored render), and an unlocked one the same way', { skip }, async () => {
  for (const lockedBy of ['connector', 'owner', null] as const) {
    const card = await approvalChannel();
    const id = await fx.slot(card.channelKey, { at: earlier(1), status: 'approved', lockedBy });
    const h = publisher();
    assert.deepEqual(await h.pub.publishDue(NOW), { published: 1, skipped: 0, failed: 0 }, String(lockedBy));
    assert.deepEqual(h.sent, [card.channelKey]);
    assert.equal((await fx.row(id)).status, 'published');
    assert.equal((await fx.row(id)).locked_by, lockedBy, 'the lock is history once it went out');
  }
});

for (const sh of SHAPES) {
  test(`row 14: a pause, a dedup hit, similarity and the daily cap still close a locked approved post with their usual reason (${sh.name})`, { skip }, async () => {
    // Paused resource.
    const c1 = await approvalChannel();
    const paused = await fx.slot(c1.channelKey, { at: earlier(1), status: 'approved', lockedBy: sh.lockedBy });
    const p = publisher({ paused: true });
    assert.deepEqual(await p.pub.publishDue(NOW), { published: 0, skipped: 1, failed: 0 });
    assert.deepEqual(await fx.state(paused), ['skipped', PAUSED_ERROR]);
    assert.equal(p.sent.length, 0);

    // Dedup: the same source went out meanwhile.
    const c2 = await approvalChannel();
    const dup = await fx.slot(c2.channelKey, { at: earlier(1), status: 'approved', lockedBy: sh.lockedBy });
    const d = publisher({ dedup: true });
    assert.deepEqual(await d.pub.publishDue(NOW), { published: 0, skipped: 1, failed: 0 });
    assert.deepEqual(await fx.state(dup), ['skipped', 'dedup_after_approval']);

    // Similarity: a near-identical text was published on the channel while it waited.
    const c3 = await approvalChannel();
    const sim = await fx.slot(c3.channelKey, { at: earlier(1), status: 'approved', lockedBy: sh.lockedBy, topic: 'same words' });
    const twin = await fx.slot(c3.channelKey, { at: earlier(2), status: 'published', topic: 'same words', written: true });
    await fx.pool.query(`UPDATE editor_slots SET rendered_preview = (SELECT rendered_preview FROM editor_slots WHERE id = $1), updated_at = now() WHERE id = $2`, [sim, twin]);
    const s = publisher();
    assert.deepEqual(await s.pub.publishDue(NOW), { published: 0, skipped: 1, failed: 0 });
    assert.deepEqual(await fx.state(sim), ['skipped', 'dedup_after_approval']);

    // Daily cap: the channel already published its maximum today.
    const c4 = await approvalChannel();
    const cap = await fx.slot(c4.channelKey, { at: earlier(1), status: 'approved', lockedBy: sh.lockedBy });
    for (let i = 0; i < 5; i++) await fx.pool.query(`INSERT INTO published_posts (channel_id, message_id, posted_at) VALUES ($1, $2, $3)`, [c4.channelKey, 100 + i, earlier(0.5)]);
    const k = publisher();
    assert.deepEqual(await k.pub.publishDue(NOW), { published: 0, skipped: 0, failed: 1 });
    assert.match((await fx.row(cap)).error, /^daily_cap_reached: 5\/5/);
    assert.equal((await fx.row(cap)).status, 'failed');
  });

  test(`row 14: expire closes a waiting or approved post nobody sent within the hold window, locked or not (${sh.name})`, { skip }, async () => {
    const card = await approvalChannel('approve');
    const waiting = await fx.slot(card.channelKey, { at: earlier(8), status: 'awaiting_approval', lockedBy: sh.lockedBy });
    const approved = await fx.slot(card.channelKey, { at: earlier(8), status: 'approved', lockedBy: sh.lockedBy });
    const done = await repo.expire(NOW);
    assert.deepEqual(done.map((x) => x.id).sort(), [waiting, approved].sort());
    assert.deepEqual(await fx.state(waiting), ['expired', 'expired: not approved in time']);
    assert.deepEqual(await fx.state(approved), ['expired', 'approved, but not published in time']);
  });
}
