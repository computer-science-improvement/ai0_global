// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flagLabel, isFlagged, ORDER_STATUS_LABEL, ORDER_STATUS_TONE, summarizeOrders } from './ad-orders';

test('every order status has an English name and a tone', () => {
  const all = ['draft', 'awaiting_payment', 'paid', 'scheduled', 'published', 'reported', 'canceled'] as const;
  for (const s of all) {
    assert.ok(ORDER_STATUS_LABEL[s], `${s} has a label`);
    assert.ok(ORDER_STATUS_TONE[s], `${s} has a tone`);
  }
  assert.equal(ORDER_STATUS_LABEL.awaiting_payment, 'Awaiting payment');
});

test('a flag reads as words; an unknown reason still reads', () => {
  assert.equal(flagLabel('no_creative'), 'no creative');
  assert.equal(flagLabel('approval_pending'), 'action not approved');
  assert.equal(flagLabel('brand_new_reason'), 'brand new reason');
});

test('only a paid or scheduled order can be flagged', () => {
  assert.equal(isFlagged({ status: 'paid', flag_reason: 'no_link' }), true);
  assert.equal(isFlagged({ status: 'scheduled', flag_reason: 'slot_failed' }), true);
  assert.equal(isFlagged({ status: 'published', flag_reason: 'slot_failed' }), false);
  assert.equal(isFlagged({ status: 'paid', flag_reason: null }), false);
  assert.equal(isFlagged({ status: 'paid' }), false);
});

test('the counts above the order list', () => {
  assert.deepEqual(summarizeOrders([]), { total: 0, awaitingPayment: 0, paid: 0, scheduled: 0, out: 0, flagged: 0 });
  assert.deepEqual(summarizeOrders([
    { status: 'draft' }, { status: 'awaiting_payment' }, { status: 'paid', flag_reason: 'no_link' }, { status: 'paid' },
    { status: 'scheduled', flag_reason: 'slot_failed' }, { status: 'published' }, { status: 'reported' }, { status: 'canceled' },
  ]), { total: 8, awaitingPayment: 2, paid: 2, scheduled: 1, out: 2, flagged: 2 });
});
