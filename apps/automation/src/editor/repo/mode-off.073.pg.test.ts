/**
 * Spec 073 T4 (FR-004) against a throwaway Postgres with every migration applied: a channel switched off is off.
 *   - `claimDue` claims nothing for a channel in mode off; the slot stays `planned`;
 *   - `skipStale` writes `mode_changed` for an overdue slot of an off channel and keeps «stale: …» for a channel that is on (slots cascade away with a deleted channel, so none is left without a row);
 *   - `upsert` off → on closes the planned content slots whose time has passed (`mode_changed`) and leaves the ones ahead,
 *     reserved slots and slots of other channels alone; other mode changes touch nothing.
 * Creates its own database next to EDITOR_PG_TEST_URL and drops it. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createMigratedDb, type FreshDb } from '../sysadmin/testing/fresh-db';
import { EditorPlansRepository } from './editor-plans.repository';
import { EditorChannelsRepository } from './editor-channels.repository';
import { makeCard } from '../post/testing/fixtures';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const MAX_LATE = 30 * 60_000;

let db: FreshDb;
let pool: Pool;
let plans: EditorPlansRepository;
let channels: EditorChannelsRepository;

before(async () => {
  if (!url) return;
  db = await createMigratedDb(url, 'mo073');
  pool = db.pool;
  plans = new EditorPlansRepository(pool);
  channels = new EditorChannelsRepository(pool);
});
after(async () => { await db?.drop(); });

const addChannel = (key: string, mode: string) => pool.query(`INSERT INTO editor_channels (channel_key, mode, formats) VALUES ($1, $2, '{"text":1}')`, [key, mode]);
const slotAt = (minutesAgo: number, topic: string) => ({ scheduledAt: new Date(Date.now() - minutesAgo * 60_000), format: 'text', topic, angle: null, sourceHints: [] as string[], isExperiment: false });
const row = async (id: string) => (await pool.query(`SELECT status, error, attempts FROM editor_slots WHERE id = $1`, [id])).rows[0];
async function idsOf(key: string): Promise<Record<string, string>> {
  const { rows } = await pool.query(`SELECT id::text, topic FROM editor_slots WHERE channel_key = $1`, [key]);
  return Object.fromEntries(rows.map((r) => [r.topic, r.id]));
}

test('claimDue: a slot of a channel in mode off stays planned; a channel that is on is claimed', { skip }, async () => {
  await addChannel('@mo_off', 'off');
  await addChannel('@mo_on', 'shadow');
  await plans.createPlan('@mo_off', '2099-02-01', 'p', null, [slotAt(5, 'due')]);
  await plans.createPlan('@mo_on', '2099-02-01', 'p', null, [slotAt(5, 'due')]);
  const claimed = (await plans.claimDue(new Date(), 50)).filter((s) => s.channelKey.startsWith('@mo_'));
  assert.deepEqual(claimed.map((s) => s.channelKey), ['@mo_on']);
  const off = await idsOf('@mo_off');
  assert.deepEqual([(await row(off.due)).status, (await row(off.due)).attempts], ['planned', 0], 'untouched: not running, no attempt counted');

  // Switching the channel on: the slot is claimable again only if it is still in the future or the upsert did not close it.
  await pool.query(`UPDATE editor_channels SET mode = 'shadow' WHERE channel_key = '@mo_off'`);
  const again = (await plans.claimDue(new Date(), 50)).filter((s) => s.channelKey === '@mo_off');
  assert.equal(again.length, 1, 'a plain mode flip (not through upsert) makes the planned slot claimable');
});

test('skipStale: an overdue slot of an off channel is skipped as mode_changed; a channel that is on keeps «stale»; a slot not yet overdue stays', { skip }, async () => {
  await addChannel('@sk_off', 'off');
  await addChannel('@sk_on', 'live');
  for (const k of ['@sk_off', '@sk_on']) await plans.createPlan(k, '2099-02-02', 'p', null, [slotAt(90, 'old'), slotAt(5, 'recent')]);
  const n = await plans.skipStale(new Date(), MAX_LATE);
  assert.ok(n >= 2, `two overdue slots were closed, got ${n}`);
  const off = await idsOf('@sk_off'); const on = await idsOf('@sk_on');
  assert.deepEqual([(await row(off.old)).status, (await row(off.old)).error], ['skipped', 'mode_changed']);
  assert.deepEqual([(await row(on.old)).status, (await row(on.old)).error], ['skipped', 'stale: missed its time window']);
  for (const ids of [off, on]) assert.equal((await row(ids.recent)).status, 'planned', 'not yet overdue by the window');
});

test('upsert off → on closes the planned content slots whose time has passed and keeps the ones ahead, reserved ones and other channels\' slots', { skip }, async () => {
  await addChannel('@up_a', 'off');
  await addChannel('@up_other', 'off');
  await plans.createPlan('@up_a', '2099-02-03', 'p', null, [slotAt(10, 'past'), slotAt(-120, 'ahead')]);
  await plans.createPlan('@up_other', '2099-02-03', 'p', null, [slotAt(10, 'past')]);
  const reservedId = await plans.reserveSlot({ channelKey: '@up_a', planDate: '2099-02-03', scheduledAt: new Date(Date.now() - 10 * 60_000), format: 'text', topic: 'ad', sourceHints: [], postSpec: { text: 'ad' } } as any);
  const a = await idsOf('@up_a'); const other = await idsOf('@up_other');

  const { previousMode, card } = await channels.upsert(makeCard({ channelKey: '@up_a', mode: 'shadow' }));
  assert.deepEqual([previousMode, card.mode], ['off', 'shadow']);
  assert.deepEqual([(await row(a.past)).status, (await row(a.past)).error], ['skipped', 'mode_changed']);
  assert.equal((await row(a.ahead)).status, 'planned', 'a slot still ahead stays planned');
  assert.equal((await row(reservedId)).status, 'planned', 'a reserved slot is not this rule\'s');
  assert.equal((await row(other.past)).status, 'planned', 'another channel is untouched');
});

test('upsert: only off → on closes slots — shadow → live, on → off, a brand-new channel and an off → off edit do not', { skip }, async () => {
  await addChannel('@up_b', 'shadow');
  await plans.createPlan('@up_b', '2099-02-04', 'p', null, [slotAt(10, 'past')]);
  const b = await idsOf('@up_b');
  await channels.upsert(makeCard({ channelKey: '@up_b', mode: 'live' }));
  assert.equal((await row(b.past)).status, 'planned', 'shadow → live');
  await channels.upsert(makeCard({ channelKey: '@up_b', mode: 'off' }));
  assert.equal((await row(b.past)).status, 'planned', 'on → off (skipStale closes it later, as mode_changed)');
  await channels.upsert(makeCard({ channelKey: '@up_b', mode: 'off', brief: 'нове' }));
  assert.equal((await row(b.past)).status, 'planned', 'off → off');

  // A brand-new channel (no row yet) has no previous mode, so nothing is "switched on" and nothing is closed.
  const first = await channels.upsert(makeCard({ channelKey: '@up_new', mode: 'shadow' }));
  assert.equal(first.previousMode, null);

  // The same channel off → on now does close them.
  await channels.upsert(makeCard({ channelKey: '@up_b', mode: 'approve' }));
  assert.deepEqual([(await row(b.past)).status, (await row(b.past)).error], ['skipped', 'mode_changed']);
});
