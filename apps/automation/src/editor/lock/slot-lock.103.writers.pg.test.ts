/**
 * Spec 103 §8, the paragraph under the table (prefix p103b_, EDITOR_PG_TEST_URL): the other slot writers act only on their own rows
 * or lanes and cannot reach a connector slot (kind 'content', resource_ref NULL, created_via 'connector', locked_by 'connector').
 * Each is stated and asserted here: pins (dropFuturePins, materialise; a LOCKED pin slot is kept by dropFuturePins), promo, sponsor, story, news watch, the SLO inserter (insert
 * only), drafts (reserved lane) and moveSlot / skipSlot from the chat card (an owner action, which keeps working on a locked slot).
 * Also: the owner's own paths on a locked slot (skip, run now, approve, edit, reschedule, reject) and lock / unlock itself.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ApprovalsRepository } from '../approval/approvals.repository';
import { ApprovalsService } from '../approval/approvals.service';
import { syncAgentsFor } from '../approval/pg-test-agents';
import { SponsorOrdersRepository } from '../../payments/sponsor-orders.repository';
import { unlinkPairs } from '../promo/promo-links';
import { makeSpec } from '../post/testing/fixtures';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { EditorPlansRepository } from '../repo/editor-plans.repository';
import { ScheduleRepository } from '../schedule/schedule.repository';
import { SloSlotInserter } from '../slo/slot-inserter';
import { buildStoryTools } from '../story/story-tools';
import { SlotLockController } from './slot-lock.controller';
import { LockFx, NOW, DAY, at, HOUR } from './testing/lock-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let fx: LockFx;
let plans: EditorPlansRepository;
let channels: EditorChannelsRepository;

before(async () => {
  if (!url) return;
  fx = await LockFx.create(url, 'writers');
  plans = new EditorPlansRepository(fx.pool, () => NOW);
  channels = new EditorChannelsRepository(fx.pool);
});
after(async () => { if (url) await fx.drop(); });

const later = (h: number) => new Date(NOW.getTime() + h * HOUR);

/** The connector-shaped slot: the thing none of the writers below may touch. */
async function connectorSlot(key: string, o: { at?: Date; status?: string } = {}) {
  return fx.slot(key, { at: o.at ?? later(6), status: o.status, lockedBy: 'connector', createdVia: 'connector', resourceRef: null, kind: 'content' });
}
/** The whole row (minus the clock columns writers bump), to compare before and after. */
const snap = async (id: string) => { const { updated_at, ...rest } = await fx.row(id); void updated_at; return JSON.stringify(rest); };

async function orchestrator(key: string): Promise<string> {
  await syncAgentsFor(fx.pool, [key]);
  return (await fx.pool.query(`SELECT id FROM agents ORDER BY created_at DESC LIMIT 1`)).rows[0].id;
}

test('pins: dropFuturePins deletes only the slots of its own rule; materialise only inserts its own (rule, date) slot', { skip }, async () => {
  const card = await fx.channel();
  const agentId = await orchestrator(card.channelKey);
  const rule = await new ScheduleRepository(fx.pool).insert(agentId, { resource_ref: `telegram:${card.channelKey}`, kind: 'pin', at_local: '18:00', format: 'text', brief: 'a daily pin for the test' } as any, 'owner');
  const repo = new ScheduleRepository(fx.pool);
  const mine = await connectorSlot(card.channelKey);
  const before = await snap(mine);
  const pin = await repo.materialise({ ruleId: rule.id, ruleDate: DAY, channelKey: card.channelKey, planDate: DAY, scheduledAt: later(8), resourceRef: null, format: 'text', topic: 'pin', sourceHints: [], seriesName: null });
  assert.ok(pin);
  assert.equal(await snap(mine), before, 'materialise did not touch it');
  assert.equal(await repo.dropFuturePins(rule.id, NOW), 1);
  assert.equal((await fx.pool.query(`SELECT 1 FROM editor_slots WHERE id = $1`, [pin])).rowCount, 0, 'the pin is gone');
  assert.equal(await snap(mine), before, 'dropFuturePins did not touch it');
});
test('pins (LOCK-5): dropFuturePins leaves a LOCKED pin slot (the owner edited it through the connector); materialise does not duplicate it', { skip }, async () => {
  const card = await fx.channel();
  const agentId = await orchestrator(card.channelKey);
  const repo = new ScheduleRepository(fx.pool);
  const rule = await repo.insert(agentId, { resource_ref: `telegram:${card.channelKey}`, kind: 'pin', at_local: '18:00', format: 'text', brief: 'a daily pin for the lock test' } as any, 'owner');
  const input = { ruleId: rule.id, ruleDate: DAY, channelKey: card.channelKey, planDate: DAY, scheduledAt: later(8), resourceRef: null, format: 'text', topic: 'pin', sourceHints: [], seriesName: null };
  const locked = await repo.materialise(input);
  const free = await repo.materialise({ ...input, ruleDate: '2099-01-01', scheduledAt: later(30) });
  assert.ok(locked && free);
  await fx.pool.query(`UPDATE editor_slots SET locked_by = 'connector', topic = 'edited in Claude' WHERE id = $1`, [locked]);
  assert.equal(await repo.dropFuturePins(rule.id, NOW), 1, 'only the unlocked pin goes');
  const row = await fx.row(locked!);
  assert.equal(row.locked_by, 'connector');
  assert.equal(row.topic, 'edited in Claude');
  assert.equal((await fx.pool.query(`SELECT 1 FROM editor_slots WHERE id = $1`, [free])).rowCount, 0);
  // The (rule, date) unique index: materialising the rule again is a no-op for the kept pin.
  assert.equal(await repo.materialise(input), null, 'no duplicate');
  assert.equal((await fx.pool.query(`SELECT 1 FROM editor_slots WHERE schedule_rule_id = $1 AND rule_date = $2`, [rule.id, DAY])).rowCount, 1);
});

test('promo: unlinkPairs and the promo claims act on slots with a promo block only', { skip }, async () => {
  const card = await fx.channel();
  const mine = await connectorSlot(card.channelKey);
  const before = await snap(mine);
  const promo = await fx.slot(card.channelKey, { at: later(7), kind: 'reserved', promo: { source_ref: 'telegram:@a', target_ref: 'telegram:@b' } });
  const r = await unlinkPairs(fx.pool as any, 'telegram:@a', ['telegram:@b']);
  assert.equal(r.canceled, 1);
  assert.equal((await fx.row(promo)).status, 'skipped');
  assert.equal(await snap(mine), before);
  assert.equal(await plans.claimPromoSlot(mine), null, 'the promo claim needs kind reserved and a promo block');
});

test('sponsor: dropSlot drops the slot it just reserved, by id', { skip }, async () => {
  const card = await fx.channel();
  const mine = await connectorSlot(card.channelKey);
  const before = await snap(mine);
  const reserved = await fx.slot(card.channelKey, { at: later(9), kind: 'reserved' });
  await new SponsorOrdersRepository(fx.pool as any).dropSlot(reserved, 'lost the race');
  assert.equal((await fx.row(reserved)).status, 'skipped');
  assert.equal(await snap(mine), before);
});

test('story: request_story_repost refuses a locked content slot the executor claimed (LOCK-1): promo and format stay, nothing is forwarded; an unlocked slot still reposts', { skip }, async () => {
  const card = await fx.channel({ mode: 'live' });
  const mine = await connectorSlot(card.channelKey, { at: NOW });
  await fx.pool.query(`UPDATE editor_slots SET format = 'longread' WHERE id = $1`, [mine]);
  const claimed = (await plans.claimDue(later(1), 50)).filter((s) => s.id === mine);
  assert.equal(claimed.length, 1, 'the executor claims the locked planned slot (running)');
  const src = { storyId: 'st-1', storyKey: 'k', storyPostId: 1, fromKey: 'ai_tech', messageId: 55, postedAt: new Date(NOW.getTime() - HOUR) };
  const forwards: unknown[] = [];
  const reposts: unknown[] = [];
  const mk = (clock: Date) => buildStoryTools({
    pool: fx.pool, plans,
    stories: { repostSource: async () => src, repostCounts: async () => ({ story: 0, day: 0 }), recordRepost: async (i: unknown) => { reposts.push(i); }, recordForward: async () => 1 },
    forward: async (...a: unknown[]) => { forwards.push(a); return 9; },
    now: () => clock,
  } as any)[0];
  const ctxFor = (slotId: string): any => ({ runId: 'r', role: 'executor', channelKey: card.channelKey, slotId, extras: { card } });
  const input = { story_key: 'k', source_post_id: 'telegram:ai_tech/55', reason: 'the neighbour already told it fully' };
  const r: any = await mk(NOW).execute(input, ctxFor(mine));
  assert.equal(r.error, 'locked_slot');
  const row = await fx.row(mine);
  assert.equal(row.promo, null, 'promo unchanged');
  assert.equal(row.format, 'longread', 'format unchanged');
  assert.equal(row.status, 'running');
  assert.deepEqual([forwards.length, reposts.length], [0, 0]);
  // The guard in SQL alone also holds: the UPDATE carries locked_by IS NULL.
  const toolSrc = readFileSync(join(__dirname, '..', 'story', 'story-tools.ts'), 'utf8');
  assert.match(toolSrc, /UPDATE editor_slots[^`]*locked_by IS NULL/);
  // An agent's own running slot is unaffected (the tool still works for it).
  const open = await fx.slot(card.channelKey, { at: NOW, lockedBy: undefined as any, resourceRef: null, kind: 'content' });
  await fx.pool.query(`UPDATE editor_slots SET status = 'running' WHERE id = $1`, [open]);
  const ok: any = await mk(NOW).execute(input, ctxFor(open));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal((await fx.row(open)).format, 'repost');
});

test('promo / reserved claims still cannot take a connector slot (kind content, no promo block)', { skip }, async () => {
  const card = await fx.channel();
  const mine = await connectorSlot(card.channelKey, { at: NOW });
  assert.equal(await plans.claimPromoSlot(mine), null);
  assert.deepEqual(await plans.claimDueReserved(later(24), 50), [], 'nor does the reserved-lane claim (kind content)');
  assert.equal((await fx.row(mine)).status, 'planned');
});

test('news watch: it only inserts live slots (no UPDATE or DELETE of editor_slots in it)', () => {
  const src = readFileSync(join(__dirname, '..', 'live', 'news-watch.ts'), 'utf8');
  assert.doesNotMatch(src, /UPDATE\s+editor_slots|DELETE\s+FROM\s+editor_slots/i);
  assert.match(src, /INSERT INTO editor_slots/);
});

test('SLO inserter: insert only; an existing connector slot is not changed, and counts toward the day (D1)', { skip }, async () => {
  const card = await fx.channel();
  const mine = await connectorSlot(card.channelKey, { at: at('13:00') });
  const before = await snap(mine);
  const id = await new SloSlotInserter({ pool: fx.pool, env: () => undefined }).insert(card, { format: 'text', topic: 'evergreen' }, { replaces: null, rung: 'evergreen', cause: null, depth: 1 }, NOW);
  assert.ok(id);
  assert.equal(await snap(mine), before);
  assert.notEqual(new Date((await fx.row(id!)).scheduled_at).getTime(), at('13:00').getTime(), 'it takes another time (the connector slot counts as taken)');
});

test('drafts (reserved lane): the draft publisher and the reserved claim never see a connector content slot', { skip }, async () => {
  const card = await fx.channel();
  const mine = await connectorSlot(card.channelKey, { at: NOW });
  assert.deepEqual(await plans.claimDueReserved(later(24), 50), []);
  assert.equal((await fx.pool.query(`SELECT 1 FROM editor_drafts WHERE slot_id = $1`, [mine])).rowCount, 0, 'no draft points at it');
  assert.equal((await fx.row(mine)).status, 'planned');
});

test('moveSlot / skipSlot from the chat card are the owner\'s action: they work on a locked slot, and the lock stays', { skip }, async () => {
  const card = await fx.channel();
  const repo = new ScheduleRepository(fx.pool);
  const a = await connectorSlot(card.channelKey, { at: later(5) });
  const moved = await repo.moveSlot(a, later(5), later(7));
  assert.equal(moved?.scheduledAt.getTime(), later(7).getTime());
  assert.equal(moved?.lockedBy, 'connector');
  const skipped = await repo.skipSlot(a, later(7), 'skipped by the owner (chat)');
  assert.equal(skipped?.status, 'skipped');
  assert.equal(skipped?.lockedBy, 'connector');
});

test('owner paths on a locked slot keep working: skip, run now, approve, edit, reschedule, reject', { skip }, async () => {
  const card = await fx.channel({ mode: 'approve' });
  await syncAgentsFor(fx.pool, [card.channelKey]);
  const svc = new ApprovalsService({ repo: new ApprovalsRepository(fx.pool), card: (k) => channels.get(k), now: () => NOW });
  // skip (the dashboard / owner bot) and run now (claimSlot)
  const planned = await connectorSlot(card.channelKey, { at: later(4) });
  assert.equal((await plans.skipPlannedSlot(planned, 'skipped by owner'))?.status, 'skipped');
  const runnable = await connectorSlot(card.channelKey, { at: later(4) });
  assert.equal((await plans.claimSlot(runnable))?.status, 'running');
  // approve, edit + approve, reschedule, reject of a waiting connector post
  const w1 = await connectorSlot(card.channelKey, { at: later(10), status: 'awaiting_approval' });
  assert.equal((await svc.approve(w1)).card.status, 'approved');
  const w2 = await connectorSlot(card.channelKey, { at: later(10), status: 'awaiting_approval' });
  const edited = await svc.edit(w2, { spec: makeSpec({ format: 'text', media: [], title: 'Edited by the owner', source: { url: 'https://src.example/edited', label: 'Src' } }) });
  assert.equal(edited.card.status, 'approved');
  assert.equal((await fx.row(w2)).locked_by, 'connector', 'an owner edit keeps the lock');
  const w3 = await connectorSlot(card.channelKey, { at: later(10), status: 'awaiting_approval' });
  const moved = await svc.reschedule(w3, { at: later(7).toISOString() });
  assert.equal(moved.card.status, 'awaiting_approval');
  const w4 = await connectorSlot(card.channelKey, { at: later(10), status: 'awaiting_approval' });
  assert.equal((await svc.reject(w4, { reason: 'no' })).card.status, 'skipped');
});

test('lock / unlock: the repository sets and clears the lock only; created_via and owner_edited stay', { skip }, async () => {
  const card = await fx.channel();
  const a = await fx.slot(card.channelKey, { at: later(5) });
  const locked = await plans.lockSlot(a, 'owner');
  assert.ok(locked && 'slot' in locked);
  assert.equal((locked as any).slot.lockedBy, 'owner');
  assert.ok((locked as any).slot.lockedAt);
  // A second lock keeps the first owner and time.
  const t0 = (await fx.row(a)).locked_at;
  const again = await plans.lockSlot(a, 'connector') as any;
  assert.equal(again.slot.lockedBy, 'owner');
  assert.equal(new Date((await fx.row(a)).locked_at).getTime(), new Date(t0).getTime());
  // Unlock clears locked_by / locked_at only.
  const b = await fx.slot(card.channelKey, { at: later(6), lockedBy: 'connector', createdVia: 'connector', ownerEdited: true, status: 'approved' });
  const open = await plans.unlockSlot(b);
  assert.equal(open?.lockedBy ?? null, null);
  assert.equal(open?.lockedAt ?? null, null);
  assert.equal(open?.createdVia, 'connector');
  assert.equal(open?.ownerEdited, true);
  assert.equal(open?.status, 'approved', 'a written post stays as it is');
  // Closed and unknown slots.
  const closed = await fx.slot(card.channelKey, { at: later(7), status: 'skipped', error: 'x' });
  assert.deepEqual(await plans.lockSlot(closed), { closed: 'skipped' });
  assert.equal(await plans.lockSlot('00000000-0000-0000-0000-000000000000'), null);
  assert.equal(await plans.unlockSlot('00000000-0000-0000-0000-000000000000'), null);
});

test('lock / unlock routes: {slot}, 404 slot_not_found, 409 slot_closed', { skip }, async () => {
  const card = await fx.channel();
  const ctl = new SlotLockController(fx.pool);
  const a = await connectorSlot(card.channelKey);
  const un = await ctl.unlock(a);
  assert.equal(un.slot.lockedBy ?? null, null);
  assert.equal(un.slot.createdVia, 'connector');
  const lk = await ctl.lock(a);
  assert.equal(lk.slot.lockedBy, 'owner');
  const closed = await fx.slot(card.channelKey, { at: later(7), status: 'failed', error: 'x' });
  await assert.rejects(ctl.lock(closed), (e: any) => e instanceof ConflictException && (e.getResponse() as any).error === 'slot_closed');
  const none = '00000000-0000-0000-0000-000000000000';
  await assert.rejects(ctl.unlock(none), (e: any) => e instanceof NotFoundException && (e.getResponse() as any).error === 'slot_not_found');
  await assert.rejects(ctl.lock(none), (e: any) => e instanceof NotFoundException);
});
