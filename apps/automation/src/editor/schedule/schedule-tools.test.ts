import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScheduleTools } from './schedule-tools';
import { hasScheduleChangeIntent } from './schedule-intent';
import { applySeriesOp, cadenceLabel, seriesDiff, seriesKey } from './series-change';
import { PlaybookSchema } from '../network/playbook';

// Spec 023 T5: the chat tools refuse without an explicit request; the intent check and the card's human diff.

test('explicit-request check: schedule verbs, time + cadence; negations and small talk are not requests', () => {
  for (const t of ['рецепти о 20:30 по буднях', 'Перенеси сьогоднішній пост на 20:00', 'пропусти вечірній слот', 'не публікуй з 13 до 15', 'move the recipe to 8 pm', 'зміни розклад рецептів']) {
    assert.equal(hasScheduleChangeIntent(t), true, t);
  }
  for (const t of ['як справи?', 'що в плані на завтра?', 'не переноси нічого', 'не треба пропускати', '> перенеси пост\nщо це було?', 'чому рецепт вийшов о 19:00?']) {
    assert.equal(hasScheduleChangeIntent(t), false, t);
  }
});

test('the propose tools answer needs_explicit_request without a request in the last message (nothing proposed)', async () => {
  const proposed: unknown[] = [];
  const schedule: any = new Proxy({}, { get: () => () => { throw new Error('the service must not be called'); } });
  const tools = Object.fromEntries(buildScheduleTools({ schedule, actions: { propose: async (a: any) => { proposed.push(a); return a; } } }).map((t) => [t.name, t]));
  const ctx: any = { runId: 'r', role: 'composer', channelKey: null, extras: { chat: { chatId: null, channelKey: '@food' }, agentIntent: false, ownerText: 'що в плані на завтра?' } };
  for (const [name, input] of [
    ['propose_series_change', { op: 'pause', series: { name: 'Рецепт дня' } }],
    ['propose_schedule_rule', { op: 'add', rule: { resource_ref: 'telegram:@food', kind: 'blackout', at_local: '13:00', until_local: '15:00' } }],
    ['propose_slot_change', { slot_id: '6b1d1b0e-3f2a-4c55-9d8e-1a2b3c4d5e6f', op: 'skip' }],
  ] as const) {
    assert.equal(((await tools[name].execute(input as any, ctx)) as any).error, 'needs_explicit_request', name);
  }
  assert.equal(proposed.length, 0);
  assert.deepEqual(tools.get_schedule.roles, ['composer']);
  assert.ok(Object.values(tools).every((t) => t.roles.length === 1 && t.roles[0] === 'composer'));
});

test('series ops: owner edits lock the series; the card shows a human diff; the staleness key follows content and lock', () => {
  const pb = PlaybookSchema.parse({
    platforms: [{ resource_ref: 'telegram:@food', role: 'core', formats: { photo: 1 }, per_day: { min: 1, max: 3 } }],
    series: [{ name: 'Рецепт дня', cadence: 'daily@19:00', resource_ref: 'telegram:@food', format: 'photo', brief: 'Рецепт щовечора з бібліотеки' }],
  });
  const r: any = applySeriesOp(pb, 'update', { name: 'Рецепт дня', cadence: 'weekly:mon,tue,wed,thu,fri@20:30' });
  assert.equal(r.after.locked, true);
  assert.equal(r.after.origin, 'agent');
  assert.equal(seriesDiff(r.before, r.after), '"Рецепт дня": every day 19:00 → weekdays 20:30');
  assert.notEqual(seriesKey(r.before), seriesKey(r.after));
  assert.equal(seriesKey({ ...r.before }), seriesKey(r.before));
  assert.equal(cadenceLabel('weekly:thu,mon@10:00,18:00'), 'Mon, Thu 10:00, 18:00');
  const add: any = applySeriesOp(pb, 'add', { name: 'Порада', cadence: 'daily@12:00', resource_ref: 'telegram:@food', format: 'photo', brief: 'Коротка кухонна порада' });
  assert.deepEqual([add.after.origin, add.after.locked], ['owner', true]);
  assert.match(seriesDiff(null, add.after), /^New series "Порада" on telegram:@food: every day 12:00 · photo/);
  assert.equal((applySeriesOp(pb, 'add', { name: 'Рецепт дня', cadence: 'daily@10:00' }) as any).error, 'series_exists');
  assert.equal((applySeriesOp(pb, 'pause', { name: 'Нема' }) as any).error, 'series_not_found');
  const paused: any = applySeriesOp(pb, 'pause', { name: 'Рецепт дня' });
  assert.equal(seriesDiff(paused.before, paused.after), '"Рецепт дня": paused');
  assert.equal((applySeriesOp(pb, 'remove', { name: 'Рецепт дня' }) as any).body.series.length, 0);
});
