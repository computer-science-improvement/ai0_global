// Spec 071: repeat in rounds — the Reuse options, the Order by selects, the reuse label and the round lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ORDER_BY, orderableFields, reuseChoice, reuseFromChoice, reuseLabel, roundLeft, roundLine, roundPercent, schemaPatch, setOrderBy,
  type CyclePolicy, type ReusePolicy,
} from './data-store';

test('reuseLabel reads every policy in one line', () => {
  assert.equal(reuseLabel({ kind: 'never' }), 'Never again');
  assert.equal(reuseLabel({ kind: 'after_days', days: 1 }), 'After 1 day');
  assert.equal(reuseLabel({ kind: 'after_days', days: 365 }), 'After 365 days');
  assert.equal(reuseLabel({ kind: 'cycle', order: 'random' }), 'In rounds, random');
  assert.equal(reuseLabel({ kind: 'cycle', order: 'sequential' }), 'In rounds, in order (import order)');
  assert.equal(reuseLabel({ kind: 'cycle', order: 'sequential', order_by: ['ticket_number', 'question_num'] }),
    'In rounds, in order (by ticket_number, then question_num)');
});

test('the four Reuse options map to policies and back; what still fits is kept', () => {
  const cases: Array<[ReusePolicy, string]> = [
    [{ kind: 'never' }, 'never'], [{ kind: 'after_days', days: 30 }, 'after_days'],
    [{ kind: 'cycle', order: 'sequential' }, 'cycle_sequential'], [{ kind: 'cycle', order: 'random' }, 'cycle_random'],
  ];
  for (const [p, c] of cases) assert.equal(reuseChoice(p), c);
  const seq: ReusePolicy = { kind: 'cycle', order: 'sequential', order_by: ['num'] };
  assert.deepEqual(reuseFromChoice('cycle_sequential', { kind: 'never' }), { kind: 'cycle', order: 'sequential' });
  assert.deepEqual(reuseFromChoice('cycle_sequential', seq), seq, 'picking the same option keeps the order fields');
  assert.deepEqual(reuseFromChoice('cycle_random', seq), { kind: 'cycle', order: 'random' }, 'random has no order fields');
  assert.deepEqual(reuseFromChoice('cycle_sequential', { kind: 'cycle', order: 'random' }), { kind: 'cycle', order: 'sequential' });
  assert.deepEqual(reuseFromChoice('after_days', { kind: 'after_days', days: 30 }), { kind: 'after_days', days: 30 });
  assert.deepEqual(reuseFromChoice('after_days', seq), { kind: 'after_days', days: 365 });
  assert.deepEqual(reuseFromChoice('never', seq), { kind: 'never' });
});

test('Order by: up to three fields in order, "Import order" sends none, a field is used once', () => {
  let p: CyclePolicy = { kind: 'cycle', order: 'sequential' };
  p = setOrderBy(p, 0, 'ticket_number');
  assert.deepEqual(p, { kind: 'cycle', order: 'sequential', order_by: ['ticket_number'] });
  p = setOrderBy(p, 1, 'question_num');
  p = setOrderBy(p, 2, 'id_text');
  assert.deepEqual(p.order_by, ['ticket_number', 'question_num', 'id_text']);
  assert.equal(p.order_by?.length, MAX_ORDER_BY);
  assert.equal(setOrderBy(p, 1, 'ticket_number'), p, 'the same field twice is ignored');
  assert.deepEqual(setOrderBy(p, 3, 'x'), p, 'there is no fourth select');
  assert.deepEqual(setOrderBy(p, 1, 'other').order_by, ['ticket_number', 'other', 'id_text'], 'changing one keeps the rest');
  // Choosing "Import order" in a select ends the list there.
  assert.deepEqual(setOrderBy(p, 1, '').order_by, ['ticket_number']);
  assert.deepEqual(setOrderBy(p, 0, ''), { kind: 'cycle', order: 'sequential' }, 'no key at all, not an empty list');
  // The next select is only reachable after the previous one is set.
  assert.deepEqual(setOrderBy({ kind: 'cycle', order: 'sequential' }, 1, 'num'), { kind: 'cycle', order: 'sequential' });
});

test('only live scalar fields can order a round', () => {
  const fields = [
    { name: 'n', type: 'int' as const }, { name: 't', type: 'text' as const }, { name: 'body', type: 'long_text' as const },
    { name: 'tags', type: 'text_list' as const }, { name: 'old', type: 'int' as const, deprecated: true }, { name: 'd', type: 'date' as const },
    { name: 'kind', type: 'enum' as const }, { name: 'j', type: 'json' as const },
  ];
  assert.deepEqual(orderableFields(fields), ['n', 't', 'd', 'kind']);
});

test('a cycle policy in the edit patch: key order from the server does not make it a change, a real change does', () => {
  const saved = { title: 'PDR', reuse_policy: { kind: 'cycle', order: 'sequential', order_by: ['a', 'b'] } as ReusePolicy };
  const sameKeysOtherOrder = JSON.parse('{"title":"PDR","reuse_policy":{"order_by":["a","b"],"order":"sequential","kind":"cycle"}}');
  assert.deepEqual(schemaPatch(saved, sameKeysOtherOrder), {});
  assert.deepEqual(schemaPatch(saved, { ...saved, reuse_policy: { kind: 'cycle', order: 'sequential', order_by: ['b', 'a'] } }),
    { reuse_policy: { kind: 'cycle', order: 'sequential', order_by: ['b', 'a'] } }, 'the order of the fields matters');
  assert.deepEqual(schemaPatch({ ...saved, reuse_policy: { kind: 'never' } as ReusePolicy }, saved), { reuse_policy: saved.reuse_policy });
  const days = { title: 'x', reuse_policy: { kind: 'after_days', days: 30 } as ReusePolicy };
  assert.deepEqual(schemaPatch(days, JSON.parse('{"title":"x","reuse_policy":{"days":30,"kind":"after_days"}}')), {});
});

test('the round lines say how far a channel is and what holds the round back', () => {
  const r = { round: 2, done: 14, total: 30, waiting: 0, open: 16 };
  assert.equal(roundLine(r), 'Round 2 · 14 of 30 posted');
  assert.equal(roundLeft(r), '16 left');
  assert.equal(roundLeft({ ...r, waiting: 2, open: 14 }), '14 left, 2 waiting for approval');
  assert.match(roundLeft({ ...r, open: 0, waiting: 2 }), /2 waiting for approval — the round rolls when they are decided/);
  assert.match(roundLeft({ ...r, open: 0 }), /Everything is posted/);
  assert.equal(roundLeft({ round: 1, done: 0, total: 0, waiting: 0, open: 0 }), 'No postable rows');
  assert.equal(roundLeft({ round: 1, done: 0, total: 5, waiting: 0, open: 0 }), 'Nothing posted in this round yet');
  assert.equal(roundPercent(r), 47);
  assert.equal(roundPercent({ done: 0, total: 0 }), 0);
  assert.equal(roundPercent({ done: 9, total: 3 }), 100);
  assert.equal(roundLine({ ...r, done: 1240, total: 5000 }), 'Round 2 · 1,240 of 5,000 posted');
});
