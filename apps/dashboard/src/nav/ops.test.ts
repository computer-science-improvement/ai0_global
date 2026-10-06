// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 027: menu edits (sidebar quick actions and the constructor draft).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAV_REGISTRY } from './registry';
import { defaultConfig, normalizeNav, resolveNav } from './resolve';
import {
  addCustomLink, addGroup, deleteGroup, hideItem, moveGroup, moveItem, moveItemBefore, nudgeGroup, nudgeItem,
  refCount, removeRef, renameGroup, setGroupHidden, setOverride, showItem, togglePin,
} from './ops';

const R = NAV_REGISTRY;
const base = () => defaultConfig();
const groupOf = (c: ReturnType<typeof base>, id: string) => c.groups.find((g) => g.items.includes(id))?.id;
const flat = (nav: ReturnType<typeof resolveNav>) => nav.groups.flatMap((g) => g.items.map((i) => i.id));

test('ops are immutable', () => {
  const c = base();
  const before = JSON.stringify(c);
  togglePin(c, 'chat'); hideItem(c, 'chat'); moveItem(c, 'chat', 'g_home', 0); setOverride(c, 'chat', { label: 'x' });
  assert.equal(JSON.stringify(c), before);
});

test('pin / unpin, at most 10', () => {
  let c = togglePin(base(), 'chat');
  assert.deepEqual(c.pinned, ['chat']);
  assert.deepEqual(resolveNav(R, c).pinned.map((i) => i.id), ['chat']);
  c = togglePin(c, 'chat');
  assert.deepEqual(c.pinned, []);
  for (const id of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10']) c = togglePin(c, id);
  assert.equal(togglePin(c, 'chat').pinned.length, 10);
});

test('hide keeps the page reachable; Overview and Settings refuse; show brings it back', () => {
  const c = hideItem(togglePin(base(), 'approvals'), 'approvals');
  assert.equal(groupOf(c, 'approvals'), undefined);
  assert.ok(c.hidden.includes('approvals'));
  assert.deepEqual(c.pinned, [], 'hiding also unpins');
  const nav = resolveNav(R, c);
  assert.ok(!flat(nav).includes('approvals'));
  assert.ok(nav.hidden.some((i) => i.id === 'approvals' && i.to === '/app/agents/inbox'));
  const ov = base();
  assert.equal(hideItem(ov, 'overview'), ov, 'a no-op returns the same object');
  const keep = base();
  assert.equal(hideItem(keep, 'settings'), keep);
  const back = showItem(c, 'approvals', 'g_agents');
  assert.equal(groupOf(back, 'approvals'), 'g_agents');
  assert.ok(!back.hidden.includes('approvals'));
});

test('move, move-before, nudge across groups, group order', () => {
  let c = moveItem(base(), 'chat', 'g_home', 0);
  assert.equal(c.groups[0].items[0], 'chat');
  c = moveItemBefore(c, 'logs', 'g_home', 'chat');
  assert.deepEqual(c.groups[0].items.slice(0, 2), ['logs', 'chat']);
  c = moveItemBefore(c, 'logs', 'g_home', null);
  assert.equal(c.groups[0].items.at(-1), 'logs');
  // Same-group drag down: before the item that was two below.
  const d = moveItemBefore(base(), 'compose', 'g_publishing', 'logs');
  assert.deepEqual(d.groups.find((g) => g.id === 'g_publishing')!.items.slice(0, 4), ['scheduled', 'editor', 'compose', 'logs']);
  // ↑ at the top of Agents hops to the end of Home; ↓ at the end of Home hops back.
  let e = nudgeItem(base(), 'agents', -1);
  assert.equal(groupOf(e, 'agents'), 'g_home');
  assert.equal(e.groups[0].items.at(-1), 'agents');
  e = nudgeItem(e, 'agents', 1);
  assert.equal(e.groups[1].items[0], 'agents');
  e = nudgeItem(e, 'chat', 1);
  assert.deepEqual(e.groups[1].items, ['agents', 'dm-inbox', 'chat']);
  assert.equal(nudgeItem(base(), 'overview', -1).groups[0].items[0], 'overview', 'top of the first group stays');
  assert.equal(moveGroup(base(), 'g_system', 0).groups[0].id, 'g_system');
  assert.equal(nudgeGroup(base(), 'g_home', 1).groups[1].id, 'g_home');
});

test('custom groups: add, rename, hide, delete (items go to Hidden; forced ones stay visible)', () => {
  let c = addGroup(base(), 'g_c_daily', '  Daily  ');
  assert.equal(c.groups.at(-1)!.title, 'Daily');
  c = moveItem(c, 'approvals', 'g_c_daily', 0);
  c = moveItem(c, 'overview', 'g_c_daily', 0);
  c = renameGroup(c, 'g_c_daily', 'Morning');
  assert.equal(c.groups.at(-1)!.title, 'Morning');
  assert.equal(renameGroup(c, 'g_home', '').groups[0].title, undefined, 'empty = default title');
  c = setGroupHidden(c, 'g_marketing', true);
  assert.ok(!flat(resolveNav(R, c)).includes('ads'));
  c = deleteGroup(c, 'g_c_daily');
  assert.ok(!c.groups.some((g) => g.id === 'g_c_daily'));
  assert.ok(c.hidden.includes('approvals'));
  assert.ok(!c.hidden.includes('overview'));
  assert.ok(flat(resolveNav(R, c)).includes('overview'));
  assert.equal(deleteGroup(base(), 'g_home').groups[0].id, 'g_home', 'built-in groups are only hidden');
});

test('rename / icon / badge override; empty label resets', () => {
  let c = setOverride(base(), 'agents', { label: ' Team ', icon: 'users', badge: false });
  assert.deepEqual(c.overrides.agents, { label: 'Team', icon: 'users', badge: false });
  c = setOverride(c, 'agents', { label: '', badge: true });
  assert.deepEqual(c.overrides.agents, { icon: 'users' });
  c = setOverride(c, 'agents', { icon: '' });
  assert.equal(c.overrides.agents, undefined);
});

test('custom links: add to a group, rename, remove; unavailable ids removed for good', () => {
  let c = addCustomLink(base(), { id: 'c_dir', label: 'Directives', icon: 'agents', to: '/app/agents/manager', search: { tab: 'directives' } }, 'g_agents');
  assert.equal(c.groups.find((g) => g.id === 'g_agents')!.items.at(-1), 'c_dir');
  c = setOverride(c, 'c_dir', { label: 'Board' });
  assert.equal(c.custom[0].label, 'Board');
  c = togglePin(c, 'c_dir');
  c = removeRef(c, 'c_dir');
  assert.deepEqual([c.custom.length, c.pinned.length, groupOf(c, 'c_dir')], [0, 0, undefined]);
  const stored = { ...base(), hidden: [...base().hidden, 'old-page'] };
  const n = normalizeNav(R, stored);
  assert.ok(n.unknownIds.has('old-page'));
  const cleaned = removeRef(n.config, 'old-page');
  assert.equal(normalizeNav(R, cleaned).unknownIds.size, 0);
  assert.equal(refCount(base()), base().groups.reduce((s, g) => s + g.items.length, 0) + base().hidden.length);
});
