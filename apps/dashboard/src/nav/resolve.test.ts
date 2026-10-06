// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 027 FR-006: resolveNav — default, unknown ids, auto-append, forced items,
// future schema, duplicates, the migration chain, custom links, overrides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAV_REGISTRY, type NavEntry } from './registry';
import { defaultNav } from './model';
import { defaultConfig, normalizeNav, resolveNav } from './resolve';
import type { NavConfigV1 } from './config';

const R = NAV_REGISTRY;
const labels = (nav: { groups: { title: string; items: { label: string }[] }[] }) =>
  Object.fromEntries(nav.groups.map((g) => [g.title, g.items.map((i) => i.label)]));
const cfg = (o: Partial<NavConfigV1> = {}): NavConfigV1 => ({ ...defaultConfig(), ...o });
const flat = (nav: { groups: { items: { id: string }[] }[] }) => nav.groups.flatMap((g) => g.items.map((i) => i.id));

test('no config → the default menu, identical to defaultNav()', () => {
  const r = resolveNav(R, null);
  assert.equal(r.source, 'default');
  const { source: _s, ...rest } = r;
  assert.deepEqual(rest, defaultNav());
  assert.deepEqual(r.warnings, []);
});

test('the default config round-trips with nothing flagged new', () => {
  const r = resolveNav(R, defaultConfig());
  assert.equal(r.source, 'saved');
  assert.deepEqual(labels(r), labels(defaultNav()));
  assert.ok(flat(r).every((id) => !r.groups.flatMap((g) => g.items).find((i) => i.id === id)!.isNew));
});

test('a newer schema shows the default menu and is marked so saving is blocked', () => {
  const r = resolveNav(R, { ...defaultConfig(), schemaVersion: 2, groups: [] });
  assert.equal(r.source, 'newer');
  assert.deepEqual(labels(r), labels(defaultNav()));
  assert.match(r.warnings[0], /newer version/);
});

test('garbage → default with a warning, never a crash', () => {
  for (const bad of ['x', 42, [], { schemaVersion: 'one' }, { schemaVersion: 0 }]) {
    const r = resolveNav(R, bad);
    assert.equal(r.source, 'invalid', JSON.stringify(bad));
    assert.deepEqual(labels(r), labels(defaultNav()));
  }
  // Missing arrays inside a v1 object are tolerated (everything is auto-appended).
  const r = resolveNav(R, { schemaVersion: 1 });
  assert.ok(flat(r).includes('overview'));
});

test('older schemas go through the migration chain', () => {
  const v1 = { schemaVersion: 1, menu: [['g_home', ['settings', 'overview']]] };
  const migrations = {
    1: (c: any) => ({ schemaVersion: 2, groups: c.menu.map(([id, items]: [string, string[]]) => ({ id, items })) }),
    2: (c: any) => ({ ...c, schemaVersion: 3, pinned: ['settings'], hidden: [], custom: [], overrides: {} }),
  };
  const r = resolveNav(R, v1, { currentVersion: 3, migrations });
  assert.equal(r.source, 'saved');
  assert.deepEqual(r.groups[0].items.slice(0, 2).map((i) => i.id), ['settings', 'overview']);
  assert.deepEqual(r.pinned.map((i) => i.id), ['settings']);
  const broken = resolveNav(R, { schemaVersion: 1 }, { currentVersion: 3, migrations: { 2: migrations[2] } });
  assert.equal(broken.source, 'invalid');
});

test('an unknown (removed) id is skipped, listed as unavailable and parked in hidden', () => {
  const c = cfg();
  c.groups[0].items.splice(1, 0, 'old-page');
  c.pinned = ['old-page', 'chat'];
  const n = normalizeNav(R, c);
  assert.ok(n.unknownIds.has('old-page'));
  assert.ok(n.config.hidden.includes('old-page'), 'kept until the owner removes it');
  assert.ok(!n.config.groups[0].items.includes('old-page'));
  const r = resolveNav(R, c);
  assert.ok(!flat(r).includes('old-page'));
  assert.deepEqual(r.unavailable, [{ id: 'old-page', label: 'old-page', reason: 'removed' }]);
  assert.deepEqual(r.pinned.map((i) => i.id), ['chat']);
  assert.ok(r.warnings.some((w) => w.includes('old-page')));
});

test('a registry page found nowhere is appended to its default group and flagged new', () => {
  const c = cfg();
  c.groups = c.groups.map((g) => ({ ...g, items: g.items.filter((id) => id !== 'spend') }));
  const r = resolveNav(R, c);
  const analytics = r.groups.find((g) => g.id === 'g_analytics')!;
  assert.equal(analytics.items[analytics.items.length - 1].id, 'spend');
  assert.equal(analytics.items[analytics.items.length - 1].isNew, true);
  // A page whose default group is missing from an old config goes to Home.
  const old = cfg();
  old.groups = old.groups.filter((g) => g.id !== 'g_content');
  const r2 = resolveNav(R, old);
  const home = r2.groups.find((g) => g.id === 'g_home')!;
  assert.equal(home.items[home.items.length - 1].id, 'data');
  // A hidden-by-default page that ships later lands in hidden, not in the menu.
  const extra: NavEntry[] = [...R, { id: 'brand-new-hidden', to: '/app/logs', label: 'Hidden one', icon: 'logs', defaultGroup: 'g_publishing', hiddenByDefault: true, keywords: [] }];
  const r3 = resolveNav(extra, cfg());
  assert.ok(r3.hidden.some((i) => i.id === 'brand-new-hidden'));
  assert.ok(!flat(r3).includes('brand-new-hidden'));
});

test('hidden items leave the menu but stay listed (still routable from ⌘K)', () => {
  const c = cfg();
  c.groups = c.groups.map((g) => ({ ...g, items: g.items.filter((id) => id !== 'approvals') }));
  c.hidden = [...c.hidden, 'approvals'];
  const r = resolveNav(R, c);
  assert.ok(!flat(r).includes('approvals'));
  const h = r.hidden.find((i) => i.id === 'approvals')!;
  assert.equal(h.to, '/app/agents/inbox');
  assert.equal(h.badge, 'approvals', 'its counter can still roll up');
});

test('Overview and Settings are always visible, even when everything is hidden', () => {
  const everything = [...new Set([...defaultConfig().groups.flatMap((g) => g.items), ...defaultConfig().hidden])];
  const r = resolveNav(R, cfg({ groups: [], hidden: everything }));
  assert.deepEqual(flat(r), ['overview', 'settings']);
  assert.equal(r.groups.length, 1, 'Home is recreated and takes both');
  assert.equal(r.groups[0].title, 'Home');
  // A hidden group cannot take them along either.
  const c = cfg();
  c.groups = c.groups.map((g) => (g.id === 'g_home' || g.id === 'g_system' ? { ...g, hidden: true } : g));
  const r2 = resolveNav(R, c);
  assert.equal(r2.groups[0].items[0].id, 'overview');
  assert.equal(r2.groups[r2.groups.length - 1].items.at(-1)!.id, 'settings');
  assert.ok(!r2.hidden.some((i) => i.id === 'overview' || i.id === 'settings'));
});

test('duplicate refs keep the first', () => {
  const c = cfg();
  c.groups[0].items.push('chat');
  const r = resolveNav(R, c);
  assert.equal(flat(r).filter((id) => id === 'chat').length, 1);
  assert.equal(r.groups[0].items.at(-1)!.id, 'chat', 'first placement (Home) wins over Agents');
  assert.ok(!r.groups.find((g) => g.id === 'g_agents')!.items.some((i) => i.id === 'chat'));
  const dupGroups = cfg();
  dupGroups.groups.push({ id: 'g_home', items: ['logs'] });
  assert.equal(resolveNav(R, dupGroups).groups.filter((g) => g.id === 'g_home').length, 1);
});

test('empty and hidden groups are not rendered; custom groups keep their title', () => {
  const c = cfg();
  c.groups.push({ id: 'g_c_empty', title: 'Empty', items: [] });
  c.groups.unshift({ id: 'g_c_daily', title: 'Daily', items: ['approvals', 'chat'] });
  c.groups = c.groups.map((g) => (g.id === 'g_marketing' ? { ...g, hidden: true } : g));
  const r = resolveNav(R, c);
  assert.equal(r.groups[0].title, 'Daily');
  assert.equal(r.groups[0].custom, true);
  assert.ok(!r.groups.some((g) => g.id === 'g_c_empty' || g.id === 'g_marketing'));
  assert.ok(r.hidden.some((i) => i.id === 'ads'), 'items of a hidden group are listed as hidden');
});

test('overrides: rename, icon (unknown icons ignored), badge off', () => {
  const c = cfg({ overrides: { agents: { label: 'Team', icon: 'users', badge: false }, chat: { icon: 'not-an-icon' } } });
  const r = resolveNav(R, c, { isIcon: (n) => n !== 'not-an-icon' });
  const agents = r.groups.flatMap((g) => g.items).find((i) => i.id === 'agents')!;
  assert.deepEqual([agents.label, agents.icon, agents.badge], ['Team', 'users', null]);
  const chat = r.groups.flatMap((g) => g.items).find((i) => i.id === 'chat')!;
  assert.equal(chat.icon, 'chat');
  // Overrides for ids that are not registry pages are dropped.
  assert.deepEqual(normalizeNav(R, cfg({ overrides: { ghost: { label: 'x' } } })).config.overrides, {});
});

test('custom links: rendered, pinned, and disabled + unavailable once their route is gone', () => {
  const c = cfg({
    custom: [
      { id: 'c_dir', label: 'Directives', icon: 'agents', to: '/app/agents/manager', search: { tab: 'directives' } },
      { id: 'c_gone', label: 'Old', icon: 'globe', to: '/app/gone' },
      { id: 'c_loose', label: 'Loose', icon: 'globe', to: '/app/logs' },
    ],
    pinned: ['c_dir', 'c_gone'],
  });
  c.groups[0].items.push('c_dir', 'c_gone');
  const routeExists = (href: string) => !href.startsWith('/app/gone');
  const r = resolveNav(R, c, { routeExists });
  const home = r.groups[0].items;
  assert.deepEqual(home.slice(-2).map((i) => [i.id, !!i.custom, !!i.unavailable]), [['c_dir', true, false], ['c_gone', true, true]]);
  assert.deepEqual(r.pinned.map((i) => i.id), ['c_dir'], 'an unavailable link is not offered as a pin');
  assert.deepEqual(r.unavailable, [{ id: 'c_gone', label: 'Old', reason: 'no-route' }]);
  assert.ok(r.hidden.some((i) => i.id === 'c_loose'), 'a custom link found nowhere stays reachable from Hidden');
});

test('pinned: known ids only, once each, at most 10', () => {
  const ids = ['chat', 'chat', 'nope', 'logs', 'ads', 'graph', 'tracked', 'spend', 'data', 'editor', 'scheduled', 'compose', 'landing'];
  const r = resolveNav(R, cfg({ pinned: ids }));
  assert.equal(r.pinned.length, 10);
  assert.equal(new Set(r.pinned.map((i) => i.id)).size, 10);
  assert.ok(!r.pinned.some((i) => i.id === 'nope'));
});
