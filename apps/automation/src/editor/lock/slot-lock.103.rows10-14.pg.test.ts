/**
 * Spec 103 §8 rows 10-14 against a throwaway Postgres (EDITOR_PG_TEST_URL, prefix p103b_): the SLO controller never replaces a
 * locked slot and reads every owner skip as the owner's decision; the directive mark and the map's copy cancel skip locked slots;
 * the executor still claims a locked PLANNED slot (the agent writes it from the owner's brief) and never claims a waiting or
 * approved post; skipStale, the off -> on past-due skip and sweepStuck still close a locked slot with their usual reason.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { OwnerInbox } from '../agents/owner-inbox';
import { AutonomyDecisionsRepository } from '../autonomy/autonomy-decisions.repository';
import { ApprovalsRepository } from '../approval/approvals.repository';
import { markDirectiveSlot } from '../manager/executors/task-report';
import { LEFT_NETWORK_SLOT_ERROR, MapActions } from '../map/map.actions';
import { makeCard } from '../post/testing/fixtures';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { EditorPlansRepository } from '../repo/editor-plans.repository';
import { ChannelSloRepository } from '../slo/channel-slo.repository';
import { SloController } from '../slo/slo-controller';
import { StubRungPlanner } from '../slo/slo-stubs';
import { SloSlotInserter } from '../slo/slot-inserter';
import { LockFx, SHAPES, NOW, DAY, at, HOUR } from './testing/lock-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let fx: LockFx;
let plans: EditorPlansRepository;

before(async () => {
  if (!url) return;
  fx = await LockFx.create(url, 'rows1014');
  plans = new EditorPlansRepository(fx.pool, () => NOW);
});
after(async () => { if (url) await fx.drop(); });

const later = (h: number) => new Date(NOW.getTime() + h * HOUR);
const earlier = (h: number) => new Date(NOW.getTime() - h * HOUR);

function controller(card: any) {
  const withCreated = { ...card, createdAt: earlier(2) };
  return new SloController({
    pool: fx.pool, repo: new ChannelSloRepository(fx.pool), inserter: new SloSlotInserter({ pool: fx.pool, env: () => undefined }),
    planner: new StubRungPlanner(), dark: { recover: async () => ({ ran: false }) } as any,
    env: () => undefined, card: async () => withCreated, slot: (id) => plans.getSlot(id),
    inbox: new OwnerInbox(fx.pool), decisions: new AutonomyDecisionsRepository(fx.pool as any),
    context: async () => ({ mode: 'live', heldReason: null, playbookPerDay: null, ownerPausedSlots: 0 }),
  } as any);
}
const sloRows = async (key: string) => (await fx.pool.query(`SELECT id, replaces_slot_id FROM editor_slots WHERE channel_key = $1 AND slo IS NOT NULL`, [key])).rows;

/** A channel with a closed slot at 08:00Z (`error`) and two planned ones later (the day's target is 3), the shape of the controller's own flow tests. */
async function closedDay(sh: { lockedBy: any }, error: string) {
  const card = await fx.channel();
  const closed = await fx.slot(card.channelKey, { at: at('08:00'), status: 'skipped', error, lockedBy: sh.lockedBy });
  for (const t of ['13:00', '15:00']) await fx.slot(card.channelKey, { at: at(t) });
  return { card, closed };
}

for (const sh of SHAPES) {
  test(`row 10: the SLO controller replaces a missed slot only when it is unlocked (${sh.name})`, { skip }, async () => {
    const { card, closed } = await closedDay(sh, 'no_fresh_item: nothing fresh in the feeds');
    const id = await controller(card).handleClosed(closed, NOW);
    if (sh.lockedBy) {
      assert.equal(id, null);
      assert.equal((await sloRows(card.channelKey)).length, 0);
    } else {
      assert.ok(id, 'an unlocked miss still gets its replacement');
      assert.deepEqual((await sloRows(card.channelKey)).map((r) => r.replaces_slot_id), [closed]);
    }
  });

  test(`row 10: the tick's make-up pass (replaceLatest) skips a locked closed slot (${sh.name})`, { skip }, async () => {
    const { card } = await closedDay(sh, 'no_fresh_item: nothing fresh in the feeds');
    await controller(card).tick([{ ...card, createdAt: earlier(2) } as any], NOW);
    assert.equal((await sloRows(card.channelKey)).length, sh.lockedBy ? 0 : 1);
  });

  for (const err of ['skipped by owner', 'skipped by owner: not this one', 'skipped by owner (connector)', 'skipped by owner (connector): changed my mind', 'skipped by the owner (chat)']) {
    test(`row 10: an owner skip ("${err}") is the owner's decision, never made up (${sh.name})`, { skip }, async () => {
      const { card, closed } = await closedDay(sh, err);
      const c = controller(card);
      assert.equal(await c.handleClosed(closed, NOW), null);
      await c.tick([{ ...card, createdAt: earlier(2) } as any], NOW);
      assert.equal((await sloRows(card.channelKey)).length, 0);
    });
  }

  test(`row 11: markDirectiveSlot marks only an unlocked slot (${sh.name})`, { skip }, async () => {
    const card = await fx.channel();
    await fx.pool.query(
      `INSERT INTO channel_slo (channel_key, day, target, state) VALUES ($1, (now() AT TIME ZONE resource_tz('telegram:' || $1))::date, 3, 'recovering')`, [card.channelKey]);
    const id = await fx.slot(card.channelKey, { at: later(3), lockedBy: sh.lockedBy });
    assert.equal(await markDirectiveSlot(fx.pool as any, id), !sh.lockedBy);
    assert.equal((await fx.row(id)).slo != null, !sh.lockedBy);
  });

  test(`row 12: cancelCopies (a resource leaves the network) skips derived copies except a locked one (${sh.name})`, { skip }, async () => {
    const card = await fx.channel();
    const source = await fx.slot(card.channelKey, { at: later(2) });
    const copy = await fx.slot(card.channelKey, { at: later(4), derivedFrom: source, lockedBy: sh.lockedBy });
    const actions = new MapActions({ pool: fx.pool, catalog: { list: async () => [] }, invalidate: () => {} });
    await (actions as any).cancelCopies(`telegram:${card.channelKey}`);
    assert.deepEqual(await fx.state(copy), sh.lockedBy ? ['planned', null] : ['skipped', LEFT_NETWORK_SLOT_ERROR]);
    assert.deepEqual(await fx.state(source), ['planned', null], 'the source is not a copy');
  });
}

test('row 13: the executor claims a locked PLANNED slot (the agent writes it from the owner\'s brief) and never a waiting or approved post', { skip }, async () => {
  for (const lockedBy of ['connector', 'owner'] as const) {
    const card = await fx.channel({ mode: 'approve' });
    const planned = await fx.slot(card.channelKey, { at: earlier(1), lockedBy, topic: 'owner brief' });
    const waiting = await fx.slot(card.channelKey, { at: earlier(1), status: 'awaiting_approval', lockedBy });
    const approved = await fx.slot(card.channelKey, { at: earlier(1), status: 'approved', lockedBy });
    const claimed = (await plans.claimDue(NOW, 50)).filter((s) => s.channelKey === card.channelKey);
    assert.deepEqual(claimed.map((s) => s.id), [planned]);
    assert.equal(claimed[0].status, 'running');
    assert.equal(claimed[0].lockedBy, lockedBy, 'the claim keeps the lock');
    assert.equal(claimed[0].topic, 'owner brief');
    assert.equal((await fx.row(waiting)).status, 'awaiting_approval');
    assert.equal((await fx.row(approved)).status, 'approved');
    // The owner's "run now" and the write-ahead claim (claimSlot) take a locked planned slot as before, and refuse the written ones.
    const p2 = await fx.slot(card.channelKey, { at: later(3), lockedBy });
    assert.equal((await plans.claimSlot(p2))?.status, 'running');
    assert.equal(await plans.claimSlot(waiting), null);
    assert.equal(await plans.claimSlot(approved), null);
    // The approval publisher's claim takes the approved one at its time (and only that one).
    const due = await new ApprovalsRepository(fx.pool).claimApprovedDue(NOW, 50);
    assert.deepEqual(due.filter((s) => s.channelKey === card.channelKey).map((s) => s.id), [approved]);
  }
});

test('row 13: the executor claim for an unlocked planned slot is as before, and a channel switched off claims nothing', { skip }, async () => {
  const card = await fx.channel();
  const id = await fx.slot(card.channelKey, { at: earlier(1) });
  const off = await fx.channel({ mode: 'off' });
  const offId = await fx.slot(off.channelKey, { at: earlier(1), lockedBy: 'connector' });
  const claimed = (await plans.claimDue(NOW, 50)).map((s) => s.id);
  assert.ok(claimed.includes(id));
  assert.ok(!claimed.includes(offId));
});

for (const sh of SHAPES) {
  test(`row 14: skipStale closes a planned slot that missed its window as before, locked or not (${sh.name})`, { skip }, async () => {
    const card = await fx.channel();
    const id = await fx.slot(card.channelKey, { at: earlier(4), lockedBy: sh.lockedBy });
    const fresh = await fx.slot(card.channelKey, { at: earlier(1), lockedBy: sh.lockedBy });
    const closed: string[] = [];
    await plans.skipStale(NOW, 3 * HOUR, (ids) => closed.push(...ids));
    assert.deepEqual(await fx.state(id), ['skipped', 'stale: missed its time window']);
    assert.ok(closed.includes(id), 'the controller hears of it (and then refuses to replace a locked one)');
    assert.equal((await fx.row(fresh)).status, 'planned');
  });

  test(`row 14: switching an off channel back on closes its past-due planned slots as mode_changed, locked or not (${sh.name})`, { skip }, async () => {
    // The switch reads the database clock, so these two use the real now.
    const real = (h: number) => new Date(Date.now() + h * HOUR);
    const card = await fx.channel({ mode: 'off' });
    const past = await fx.slot(card.channelKey, { at: real(-2), lockedBy: sh.lockedBy });
    const ahead = await fx.slot(card.channelKey, { at: real(2), lockedBy: sh.lockedBy });
    await new EditorChannelsRepository(fx.pool).upsert(makeCard({ channelKey: card.channelKey, mode: 'live' }));
    assert.deepEqual(await fx.state(past), ['skipped', 'mode_changed']);
    assert.deepEqual(await fx.state(ahead), ['planned', null]);
  });

  test(`row 14: sweepStuck fails a slot stuck in running, locked or not (${sh.name})`, { skip }, async () => {
    const card = await fx.channel();
    const id = await fx.slot(card.channelKey, { at: earlier(3), status: 'running', lockedBy: sh.lockedBy, updatedAt: earlier(1) });
    const swept = await plans.sweepStuck(NOW, 15 * 60_000);
    assert.ok(swept.some((s) => s.id === id));
    assert.deepEqual(await fx.state(id), ['failed', 'stuck in running (crash?)']);
  });
}

test('row 14: a day constant stays in the tests', () => { assert.equal(DAY, '2026-11-06'); });
