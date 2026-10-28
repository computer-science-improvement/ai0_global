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
  assert.deepEqual(badgeFor('agentsInbox', all), { count: 7, tone: 'warning', title: '4 unread · 3 posts to approve' });
  assert.deepEqual(badgeFor('agentsInbox', { ...all, agentInboxCritical: 2 }), { count: 7, tone: 'danger', title: '4 unread, 2 critical · 3 posts to approve' });
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
  assert.equal(badgeFor(inbox.badge, all)?.count, 7, 'unread 4 + posts to approve 3');
  assert.ok(nav.hidden.some((i) => i.id === 'approvals'));
  const off = resolveNav(NAV_REGISTRY, setOverride(defaultConfig(), 'agents-inbox', { badge: false }));
  assert.equal(off.groups.flatMap((g) => g.items).find((i) => i.id === 'agents-inbox')!.badge, null);
});

test('the Inbox sums unread notes and posts to approve; either source alone is enough, both unknown is nothing', () => {
  assert.deepEqual(badgeFor('agentsInbox', { agentInboxUnread: 4 }), { count: 4, tone: 'warning', title: '4 unread' });
  assert.deepEqual(badgeFor('agentsInbox', { approvalsWaiting: 1 }), { count: 1, tone: 'warning', title: '1 post to approve' });
  assert.deepEqual(badgeFor('agentsInbox', { agentInboxUnread: null, approvalsWaiting: 2 }), { count: 2, tone: 'warning', title: '2 posts to approve' });
  assert.equal(badgeFor('agentsInbox', { agentInboxUnread: 0, approvalsWaiting: 0 }), null);
  assert.equal(badgeFor('agentsInbox', { agentInboxUnread: null, approvalsWaiting: null }), null);
  assert.equal(badgeFor('agentsInbox', { agentInboxCritical: 3 }), null, 'a critical count alone is not a counter');
  // Tone: danger only with a critical note, never because approvals wait.
  assert.equal(badgeFor('agentsInbox', { agentInboxUnread: 1, agentInboxCritical: 1, approvalsWaiting: 5 })!.tone, 'danger');
  assert.equal(badgeFor('agentsInbox', { agentInboxUnread: 1, agentInboxCritical: 0, approvalsWaiting: 5 })!.tone, 'warning');
});

test('Agents shows the directives counter only; the old "agents" key is gone', () => {
  const nav = resolveNav(NAV_REGISTRY, null);
  const agents = nav.groups.flatMap((g) => g.items).find((i) => i.id === 'agents')!;
  assert.equal(agents.badge, 'directives');
  assert.equal(badgeFor(agents.badge, all), null, 'unread notes no longer count here');
  assert.equal(badgeFor(agents.badge, { ...all, directivesAwaitingOwner: 2 })!.count, 2);
  assert.ok(!NAV_REGISTRY.some((e) => (e.badge as string | undefined) === 'agents'));
});

test('hidden pages roll up (the hamburger / More tools dot); the strongest tone wins', () => {
  const nav = resolveNav(NAV_REGISTRY, hideItem(defaultConfig(), 'chat'));
  const hidden = rollup(nav.hidden, all);
  assert.ok(hidden);
  assert.equal(hidden!.tone, 'danger', 'a failed slot today is danger');
  assert.equal(rollup(nav.hidden, { ...all, slotsFailedToday: 0 })!.tone, 'warning');
  assert.match(hidden!.title, /Posts to approve: 3 posts awaiting approval/, 'with no Inbox in the list, approvals count for themselves');
  assert.equal(rollup(nav.hidden, {}), null);
});

test('rollup never counts a covered counter twice, whichever comes first (the mobile hamburger passes every item)', () => {
  const nav = resolveNav(NAV_REGISTRY, null);
  const visible = [...nav.pinned, ...nav.groups.flatMap((g) => g.items)];
  const inbox = visible.find((i) => i.id === 'agents-inbox')!;
  const approvals = nav.hidden.find((i) => i.id === 'approvals')!;
  const counts: BadgeCounts = { agentInboxUnread: 4, approvalsWaiting: 3 };
  const full = rollup([...visible, ...nav.hidden], counts)!;
  assert.equal(full.count, 7, 'the Inbox (4 + 3) once, approvals not again');
  assert.equal(full.title, 'Inbox: 4 unread · 3 posts to approve');
  const swapped = rollup([approvals, inbox], counts)!;
  assert.equal(swapped.count, 7, 'order does not matter');
  assert.equal(swapped.title, 'Inbox: 4 unread · 3 posts to approve');
  // All the default counters together: Inbox 7, Chat 1, DM inbox 7, Editor 1; approvals are inside the Inbox.
  assert.equal(rollup([...visible, ...nav.hidden], all)!.count, 7 + 1 + 7 + 1);
});

test('by default only pages the menu does not show roll up: approvals sit inside the Inbox, directives inside Agents', () => {
  const nav = resolveNav(NAV_REGISTRY, null);
  const visible = [...nav.pinned, ...nav.groups.flatMap((g) => g.items)];
  const skip = shownKeys(visible);
  assert.ok(skip.has('agentsInbox') && skip.has('approvals') && skip.has('directives'));
  assert.equal(rollup(nav.hidden, { agentInboxUnread: 4, approvalsWaiting: 3, directivesAwaitingOwner: 2 }, skip), null);
  // The hidden DM inbox and Editor still surface.
  const r = rollup(nav.hidden, { ...all, directivesAwaitingOwner: 2 }, skip)!;
  assert.equal(r.count, 7 + 1);
  assert.equal(r.tone, 'danger');
  assert.doesNotMatch(r.title, /Posts to approve|Inbox:/);
});

test('hide the Inbox, or turn its counter off, and the approvals counter rolls up again', () => {
  const hiddenInbox = resolveNav(NAV_REGISTRY, hideItem(defaultConfig(), 'agents-inbox'));
  const visible = [...hiddenInbox.pinned, ...hiddenInbox.groups.flatMap((g) => g.items)];
  const counts: BadgeCounts = { agentInboxUnread: 4, approvalsWaiting: 3 };
  assert.equal(rollup(hiddenInbox.hidden, counts, shownKeys(visible))!.count, 7, 'Inbox (4 + 3) once; approvals are covered by it');
  const off = resolveNav(NAV_REGISTRY, setOverride(defaultConfig(), 'agents-inbox', { badge: false }));
  const offVisible = [...off.pinned, ...off.groups.flatMap((g) => g.items)];
  const r = rollup(off.hidden, counts, shownKeys(offVisible))!;
  assert.equal(r.count, 3);
  assert.match(r.title, /Posts to approve: 3 posts awaiting approval/);
});
