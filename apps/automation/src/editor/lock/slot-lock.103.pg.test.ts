/**
 * Spec 103 §8 rows 1-6 against a throwaway Postgres (EDITOR_PG_TEST_URL, prefix p103b_): a locked slot (locked by the connector
 * or by the owner) is left alone by replans, the planner's fixed points, series tagging, the pre-flight re-topic, the config gate
 * patch and the series pause; an unlocked slot behaves exactly as before.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EditorPlansRepository } from '../repo/editor-plans.repository';
import { ScheduleRepository } from '../schedule/schedule.repository';
import { SeriesPausesRepository } from '../series-pause/series-pauses.repository';
import { LockFx, SHAPES, NOW, DAY, at, HOUR } from './testing/lock-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let fx: LockFx;
let plans: EditorPlansRepository;

before(async () => {
  if (!url) return;
  fx = await LockFx.create(url, 'rows16');
  plans = new EditorPlansRepository(fx.pool, () => NOW);
});
after(async () => { if (url) await fx.drop(); });

const newSlot = (t: string, topic: string) => ({ scheduledAt: at(t), format: 'text', topic, angle: null, sourceHints: [] as string[], isExperiment: false });

for (const sh of SHAPES) {
  test(`row 1: a replan ${sh.lockedBy ? 'keeps' : 'replaces'} a planned slot (${sh.name}); the new plan has room beside it`, { skip }, async () => {
    const card = await fx.channel();
    const planned = await fx.slot(card.channelKey, { at: at('16:00'), lockedBy: sh.lockedBy, topic: 'mine' });
    const sameTime = await fx.slot(card.channelKey, { at: at('18:00') });          // an unlocked neighbour, always replaced
    const old = (await fx.row(planned)).plan_id;
    await plans.createPlan(card.channelKey, DAY, 'a second plan of the day', null, [newSlot('16:00', 'agent plan'), newSlot('20:00', 'agent plan 2')]);
    const row = await fx.row(planned);
    const active = (await fx.pool.query(`SELECT id FROM editor_plans WHERE channel_key = $1 AND status = 'active'`, [card.channelKey])).rows[0].id;
    if (sh.lockedBy) {
      assert.equal(row.status, 'planned');
      assert.equal(row.error, null);
      assert.equal(row.plan_id, active, 'moved to the new plan');
      assert.equal(row.locked_by, sh.lockedBy);
      assert.equal(row.topic, 'mine');
    } else {
      assert.equal(row.status, 'skipped');
      assert.equal(row.error, 'superseded by a new plan');
      assert.equal(row.plan_id, old, 'stays in the superseded plan');
    }
    assert.deepEqual(await fx.state(sameTime), ['skipped', 'superseded by a new plan']);
    // The planner's new slot at the same minute as a kept locked slot is fine (no unique index on the time).
    const atSame = (await fx.pool.query(`SELECT count(*)::int AS n FROM editor_slots WHERE plan_id = $1 AND scheduled_at = $2`, [active, at('16:00')])).rows[0].n;
    assert.equal(atSame, sh.lockedBy ? 2 : 1);
  });
}

test('row 1: locked written posts (awaiting_approval, approved) and a locked running slot move to the new plan', { skip }, async () => {
  const card = await fx.channel({ mode: 'approve' });
  const ids = [
    await fx.slot(card.channelKey, { at: at('15:00'), status: 'awaiting_approval', lockedBy: 'connector' }),
    await fx.slot(card.channelKey, { at: at('17:00'), status: 'approved', lockedBy: 'owner', ownerEdited: true }),
    await fx.slot(card.channelKey, { at: at('19:00'), status: 'running', lockedBy: 'connector' }),
  ];
  await plans.createPlan(card.channelKey, DAY, 'replan', null, [newSlot('21:00', 'new')]);
  const active = (await fx.pool.query(`SELECT id FROM editor_plans WHERE channel_key = $1 AND status = 'active'`, [card.channelKey])).rows[0].id;
  for (const id of ids) { const r = await fx.row(id); assert.equal(r.plan_id, active); assert.notEqual(r.status, 'skipped'); }
});

test('row 1: a locked slot that is already closed is not dragged into the new plan; a locked slot inside the keep lead stays too', { skip }, async () => {
  const card = await fx.channel();
  const closed = await fx.slot(card.channelKey, { at: at('13:00'), status: 'skipped', error: 'skipped by owner (connector)', lockedBy: 'connector' });
  const soon = await fx.slot(card.channelKey, { at: new Date(NOW.getTime() + 2 * 60_000), lockedBy: 'connector' });
  const old = (await fx.row(closed)).plan_id;
  await plans.createPlan(card.channelKey, DAY, 'replan', null, [newSlot('20:00', 'new')]);
  assert.equal((await fx.row(closed)).plan_id, old, 'closed history stays with the old plan');
  assert.equal((await fx.row(soon)).status, 'planned');
});

for (const sh of SHAPES) {
  test(`row 2: keptOn shows a far-ahead planned slot to the planner as a fixed point only when locked (${sh.name})`, { skip }, async () => {
    const card = await fx.channel();
    const id = await fx.slot(card.channelKey, { at: at('21:00'), lockedBy: sh.lockedBy });
    const repo = new ScheduleRepository(fx.pool);
    const kept = await repo.keptOn(card.channelKey, DAY, new Date(NOW.getTime() + 5 * 60_000));
    assert.equal(kept.some((s) => s.id === id), !!sh.lockedBy);
    if (sh.lockedBy) assert.equal(kept.find((s) => s.id === id)!.lockedBy, sh.lockedBy);
  });

  test(`row 3: a series hint does not tag a locked slot kept in the new plan (${sh.name})`, { skip }, async () => {
    const card = await fx.channel();
    const id = await fx.slot(card.channelKey, { at: at('21:00'), lockedBy: sh.lockedBy, hints: ['series:Nightly'], status: 'running' });
    await plans.createPlan(card.channelKey, DAY, 'replan', null, [{ ...newSlot('22:00', 'agent'), sourceHints: ['series:Agent'] }]);
    const mine = (await fx.row(id)).series_name;
    assert.equal(mine, sh.lockedBy ? null : 'Nightly');
    const agent = (await fx.pool.query(`SELECT series_name FROM editor_slots WHERE channel_key = $1 AND topic = 'agent'`, [card.channelKey])).rows[0];
    assert.equal(agent.series_name, 'Agent', 'the agent\'s own new slot is tagged as before');
  });

  test(`row 4: retopicSlot rewrites topic, angle and hints only of an unlocked slot (${sh.name})`, { skip }, async () => {
    const card = await fx.channel();
    const id = await fx.slot(card.channelKey, { at: at('19:00'), lockedBy: sh.lockedBy, topic: 'owner brief' });
    await plans.retopicSlot(id, { ideaId: '00000000-0000-0000-0000-000000000001', topic: 'swapped', angle: 'a', sourceHints: ['https://x.example'], note: 'preflight_swap: x' });
    const r = await fx.row(id);
    assert.equal(r.topic, sh.lockedBy ? 'owner brief' : 'swapped');
    assert.equal(r.idea_id, sh.lockedBy ? null : '00000000-0000-0000-0000-000000000001');
    assert.deepEqual(r.lint_warnings ?? [], sh.lockedBy ? [] : ['preflight_swap: x']);
  });

  test(`row 5: patchSlotConfig fixes the format and hints of a running slot only when it is unlocked (${sh.name})`, { skip }, async () => {
    const card = await fx.channel();
    const id = await fx.slot(card.channelKey, { at: at('12:00'), status: 'running', lockedBy: sh.lockedBy, hints: ['a'] });
    const out = await plans.patchSlotConfig(id, { format: 'photo', sourceHints: ['b'], note: 'repair' });
    const r = await fx.row(id);
    if (sh.lockedBy) {
      assert.equal(out, null);
      assert.equal(r.format, 'text');
      assert.deepEqual(r.source_hints, ['a']);
      assert.equal(r.fallback, null);
    } else {
      assert.equal(out?.format, 'photo');
      assert.deepEqual(r.source_hints, ['b']);
    }
  });

  test(`row 6: a series, rule or resource pause skips planned slots but leaves a locked one (${sh.name})`, { skip }, async () => {
    const card = await fx.channel();
    const key = card.channelKey;
    const bySeries = await fx.slot(key, { at: at('15:00'), lockedBy: sh.lockedBy, seriesName: 'Daily' });
    const byResource = await fx.slot(key, { at: at('17:00'), lockedBy: sh.lockedBy });
    const pauses = new SeriesPausesRepository(fx.pool, { sloOn: () => true });
    assert.equal(await pauses.skipPlanned({ channelKey: key, key: 'series:Daily', label: 'Daily', cause: 'owner' }), sh.lockedBy ? 0 : 1);
    assert.equal(await pauses.skipPlanned({ channelKey: key, key: `resource:telegram:${key}`, label: key, cause: 'owner' }), sh.lockedBy ? 0 : 1);
    const expected = sh.lockedBy ? 'planned' : 'skipped';
    assert.equal((await fx.row(bySeries)).status, expected);
    assert.equal((await fx.row(byResource)).status, expected);
    if (!sh.lockedBy) assert.match((await fx.row(bySeries)).error, /^series_paused:/);
  });
}

test('the lock rule is one fragment: the helpers name it and every writer uses it', async () => {
  const { unlockedSql, lockedSql, isLocked } = await import('../repo/slot-lock');
  assert.equal(unlockedSql('s'), 's.locked_by IS NULL');
  assert.equal(lockedSql(), 'locked_by IS NOT NULL');
  assert.equal(isLocked({ lockedBy: 'connector' }), true);
  assert.equal(isLocked({ lockedBy: null }), false);
  assert.equal(HOUR, 3_600_000);
});
