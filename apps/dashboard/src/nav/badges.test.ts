// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 027 FR-010/FR-011: which counter each item shows, its tone, the 99+ cap,
// null/zero → nothing, the per-item toggle and the roll-up of hidden pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAV_REGISTRY } from './registry';
import { defaultConfig, resolveNav } from './resolve';
import { badgeFor, badgeText, rollup, shownKeys, type BadgeCounts } from './badges';
import { hideItem, setOverride } from './ops';

const all: BadgeCounts = {
  approvalsWaiting: 3, agentInboxUnread: 4, agentInboxCritical: 0, directivesAwaitingOwner: 0,
  chatPendingActions: 1, dmThreadsNew: 2, dmActionsPending: 5, slotsFailedToday: 1, scheduledFailedToday: 0,
};

test('each binding: count, tone and an English title', () => {
  assert.deepEqual(badgeFor('approvals', all), { count: 3, tone: 'warning', title: '3 posts awaiting approval' });
  assert.deepEqual(badgeFor('agentsInbox', { ...all, agentInboxCritical: 2 }), { count: 4, tone: 'danger', title: '4 unread, 2 critical' });
  assert.deepEqual(badgeFor('directives', { directivesAwaitingOwner: 1 }), { count: 1, tone: 'danger', title: '1 directive awaits your decision' });
  assert.deepEqual(badgeFor('chat', all), { count: 1, tone: 'warning', title: '1 change to confirm in the chat' });
  assert.deepEqual(badgeFor('dm', all), { count: 7, tone: 'warning', title: '2 new DMs · 5 replies to approve' });
  assert.deepEqual(badgeFor('editor', all), { count: 1, tone: 'danger', title: '1 slot failed today' });
  assert.equal(badgeFor('scheduled', all), null, 'zero → no badge');
  assert.equal(badgeFor(null, all), null);
});

test('null (failed source or missing table) and absent counts render nothing', () => {
  const none: BadgeCounts = { approvalsWaiting: null, agentInboxUnread: null, directivesAwaitingOwner: null, dmThreadsNew: null, dmActionsPending: null };
  for (const k of ['approvals', 'agentsInbox', 'directives', 'chat', 'dm', 'editor', 'scheduled'] as const) {
    assert.equal(badgeFor(k, none), null, k);
    assert.equal(badgeFor(k, {}), null, k);
  }
  // One source of a sum failing still shows the other.
  assert.equal(badgeFor('dm', { dmThreadsNew: null, dmActionsPending: 2 })?.count, 2);
});

test('the pill caps at 99+', () => {
  assert.equal(badgeText(7), '7');
  assert.equal(badgeText(99), '99');
  assert.equal(badgeText(100), '99+');
});

test('the Inbox counter is on by default (approvals are hidden); the per-item toggle turns a counter off', () => {
  const nav = resolveNav(NAV_REGISTRY, null);
  const inbox = nav.groups.flatMap((g) => g.items).find((i) => i.id === 'agents-inbox')!;
  assert.equal(badgeFor(inbox.badge, all)?.count, 4);
  assert.ok(nav.hidden.some((i) => i.id === 'approvals'));
  const off = resolveNav(NAV_REGISTRY, setOverride(defaultConfig(), 'agents-inbox', { badge: false }));
  assert.equal(off.groups.flatMap((g) => g.items).find((i) => i.id === 'agents-inbox')!.badge, null);
});

test('hidden pages roll up (the hamburger / More tools dot); the strongest tone wins', () => {
  const nav = resolveNav(NAV_REGISTRY, hideItem(defaultConfig(), 'chat'));
  const hidden = rollup(nav.hidden, all);
  assert.ok(hidden);
  assert.equal(hidden!.tone, 'danger', 'a failed slot today is danger');
  assert.equal(rollup(nav.hidden, { ...all, slotsFailedToday: 0 })!.tone, 'warning');
  assert.match(hidden!.title, /Posts to approve: 3 posts awaiting approval/);
  const everything = rollup([...nav.pinned, ...nav.groups.flatMap((g) => g.items), ...nav.hidden], all);
  assert.equal(everything!.tone, 'danger');
  assert.equal(rollup(nav.hidden, {}), null);
});
