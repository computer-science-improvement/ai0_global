import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findStuckOrders, formatStuck, runStuckCheck, stuckReason } from './stuck-ad-orders';
import type { OpenOrderRow } from './sponsor-orders.repository';

const NOW = new Date('2026-10-12T09:00:00Z'); // 12:00 Kyiv
const ago = (h: number) => new Date(NOW.getTime() - h * 3600_000);

function row(over: Partial<OpenOrderRow> = {}): OpenOrderRow {
  return {
    id: 'o1', advertiser: 'Курс', status: 'paid', amount: '400.00', currency: 'UAH', format: 'digest_sponsor', channelKey: '@chan',
    publishAt: ago(30), paidAt: ago(48), createdAt: ago(72), flagReason: null, editorSlotId: null, slotStatus: null, actionStatus: null, ...over,
  };
}

test('stuckReason: digest sponsors whose day is over or that have no date', () => {
  assert.equal(stuckReason(row(), NOW), 'day_passed');
  assert.equal(stuckReason(row({ publishAt: ago(2) }), NOW), null, 'today: the digest (or the reserved lane) may still publish it');
  assert.equal(stuckReason(row({ publishAt: null }), NOW), 'no_publish_date');
  assert.equal(stuckReason(row({ editorSlotId: 's1', slotStatus: 'planned', status: 'scheduled' }), NOW), null, 'placed: the reserved lane owns it');
  assert.equal(stuckReason(row({ editorSlotId: 's1', slotStatus: 'failed', status: 'scheduled' }), NOW), 'slot_failed');
});

test('stuckReason: posts never scheduled or never approved after their time', () => {
  assert.equal(stuckReason(row({ format: 'post' }), NOW), 'not_scheduled');
  assert.equal(stuckReason(row({ format: 'post', publishAt: ago(5) }), NOW), null);
  assert.equal(stuckReason(row({ format: 'post', publishAt: null }), NOW), null, 'no date yet: waiting for the owner to schedule');
  assert.equal(stuckReason(row({ format: null, status: 'scheduled', actionStatus: 'pending' }), NOW), 'approval_pending');
  assert.equal(stuckReason(row({ format: 'pin_24h', status: 'scheduled', actionStatus: 'done' }), NOW), null, 'approved into scheduled_posts');
});

test('runStuckCheck: flags each stuck order once and posts only the new ones in one Inbox action', async () => {
  const flags = new Map<string, string>();
  const posted: any[] = [];
  const rows = [row(), row({ id: 'o2', format: 'post' }), row({ id: 'o3', publishAt: ago(1) })];
  const deps = {
    orders: {
      openOrders: async () => rows,
      flag: async (id: string, reason: string) => { if (flags.get(id) === reason) return false; flags.set(id, reason); return true; },
    },
    inbox: { post: async (i: any) => { posted.push(i); return 1; } },
  };
  const fresh = await runStuckCheck(deps, NOW);
  assert.deepEqual(fresh.map((o) => [o.id, o.reason]), [['o1', 'day_passed'], ['o2', 'not_scheduled']]);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].kind, 'ad_orders_stuck');
  assert.equal(posted[0].severity, 'action');
  assert.match(posted[0].body, /2 paid ad order\(s\) not published/);
  assert.match(posted[0].body, /Nothing is refunded or published automatically/);
  assert.deepEqual(await runStuckCheck(deps, NOW), [], 'a second run reports nothing new');
  assert.equal(posted.length, 1);
});

test('findStuckOrders + formatStuck: the read-only CLI listing', async () => {
  const list = await findStuckOrders({ openOrders: async () => [row()] }, NOW);
  assert.match(formatStuck(list), /«Курс» · digest_sponsor · @chan · 400\.00 UAH · paid · publish 2026-10-11 — digest sponsor day is over/);
  assert.equal(formatStuck([]), 'No paid ad order is stuck.');
});
