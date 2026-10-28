// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 D4: the saved-menu migration v1 → v2. The v1 fixtures below are frozen
// (the v1 default menu as the base commit built it), so they do not move when the
// registry does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAV_REGISTRY, menuEntries } from './registry';
import { NAV_SCHEMA_VERSION, type NavConfig } from './config';
import { MIGRATIONS, defaultConfig, normalizeNav, resolveNav } from './resolve';
import { V1_DEFAULT_HIDDEN, migrateV1ToV2 } from './migrate';

const R = NAV_REGISTRY;

/** The v1 default menu, as a v1 build wrote or showed it (frozen). */
const v1Default = () => ({
  schemaVersion: 1,
  groups: [
    { id: 'g_home', items: ['overview', 'approvals', 'health'] },
    { id: 'g_agents', items: ['agents', 'chat', 'artifacts', 'dm-inbox', 'models', 'network-map'] },
    { id: 'g_publishing', items: ['compose', 'scheduled', 'editor', 'logs', 'channels'] },
    { id: 'g_content', items: ['data'] },
    { id: 'g_analytics', items: ['analytics', 'spend', 'tracked'] },
    { id: 'g_intelligence', items: ['discovery', 'graph', 'recommendations'] },
    { id: 'g_connections', items: ['connections', 'groups'] },
    { id: 'g_marketing', items: ['landing', 'ads'] },
    { id: 'g_system', items: ['settings'] },
  ] as Array<{ id: string; title?: string; hidden?: boolean; items: string[] }>,
  pinned: [] as string[],
  hidden: ['agents-inbox', 'directives', 'bots', 'telegraph', 'connections-meta', 'connections-tiktok', 'settings-navigation', 'settings-security', 'settings-ai'],
  custom: [] as Array<Record<string, unknown>>,
  overrides: {} as Record<string, Record<string, unknown>>,
});

const migrate = (old: unknown): NavConfig => normalizeNav(R, old).config;
const where = (c: NavConfig, id: string): string | null =>
  c.groups.find((g) => g.items.includes(id))?.id ?? (c.hidden.includes(id) ? 'hidden' : null);
const shown = (c: NavConfig) => c.groups.filter((g) => !g.hidden).flatMap((g) => g.items);

test('the schema version this build writes is 2', () => {
  assert.equal(NAV_SCHEMA_VERSION, 2);
  assert.equal(defaultConfig().schemaVersion, 2);
  assert.equal(typeof MIGRATIONS[1], 'function');
});

test('V1_DEFAULT_HIDDEN is the v1 default hidden list, frozen', () => {
  assert.deepEqual([...V1_DEFAULT_HIDDEN].sort(), [...v1Default().hidden].sort());
});

test('an untouched v1 default menu becomes exactly the v2 default menu', () => {
  assert.deepEqual(migrate(v1Default()), defaultConfig());
  const r = resolveNav(R, v1Default());
  assert.equal(r.source, 'saved');
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.groups.map((g) => [g.title, g.items.map((i) => i.id)]), [
    ['Home', ['overview', 'agents-inbox', 'chat']],
    ['Network', ['agents', 'calendar', 'channels', 'network-map']],
    ['Insights', ['analytics', 'spend', 'health']],
    ['System', ['settings']],
  ]);
});

test('a v1 menu with one item at the end is still the default (order inside groups is not carried)', () => {
  const v1 = v1Default();
  v1.groups[1].items = ['network-map', 'models', 'dm-inbox', 'artifacts', 'chat', 'agents'];
  assert.deepEqual(migrate(v1), defaultConfig());
});

test('the result is of the current schema and migrating again changes nothing', () => {
  const v1 = v1Default();
  v1.pinned = ['chat'];
  v1.hidden.push('spend');
  v1.groups[4].items = ['analytics', 'tracked'];
  const once = migrate(v1);
  assert.equal(once.schemaVersion, NAV_SCHEMA_VERSION);
  assert.deepEqual(normalizeNav(R, once).config, once, 'a v2 config is not migrated again');
  assert.deepEqual(migrateV1ToV2(once, defaultConfig(), R).groups.map((g) => g.id), once.groups.map((g) => g.id));
});

test('pins, overrides and custom links are carried over', () => {
  const v1 = v1Default();
  v1.pinned = ['chat', 'c_dir', 'logs'];
  v1.overrides = { agents: { label: 'Crew', icon: 'users', badge: false }, chat: { label: 'Talk' } };
  v1.custom = [{ id: 'c_dir', label: 'Directives', icon: 'agents', to: '/app/agents/manager', search: { tab: 'directives' } }];
  v1.groups[0].items.push('c_dir');
  const c = migrate(v1);
  assert.deepEqual(c.pinned, ['chat', 'c_dir', 'logs']);
  assert.deepEqual(c.overrides, { agents: { label: 'Crew', icon: 'users', badge: false }, chat: { label: 'Talk' } });
  assert.deepEqual(c.custom, [{ id: 'c_dir', label: 'Directives', icon: 'agents', to: '/app/agents/manager', search: { tab: 'directives' } }]);
  assert.equal(where(c, 'c_dir'), 'g_home', 'a link in a group that survives stays in it');
  assert.equal(c.groups.find((g) => g.id === 'g_home')!.items.at(-1), 'c_dir');
});

test('a custom link in a group that no longer exists goes to the hidden list, not away', () => {
  const v1 = v1Default();
  v1.custom = [{ id: 'c_pub', label: 'Calendar', icon: 'globe', to: '/app/scheduled' }, { id: 'c_loose', label: 'Loose', icon: 'globe', to: '/app/logs' }];
  v1.groups[2].items.push('c_pub');
  const c = migrate(v1);
  assert.equal(where(c, 'c_pub'), 'hidden');
  assert.equal(where(c, 'c_loose'), 'hidden', 'a link that was in no group stays reachable');
  assert.ok(c.custom.some((x) => x.id === 'c_pub'));
});

test('pages the owner hid on purpose stay hidden', () => {
  const v1 = v1Default();
  v1.groups[1].items = v1.groups[1].items.filter((id) => id !== 'chat');
  v1.groups[4].items = v1.groups[4].items.filter((id) => id !== 'spend');
  v1.hidden.push('chat', 'spend', 'channels');
  v1.groups[2].items = v1.groups[2].items.filter((id) => id !== 'channels');
  const c = migrate(v1);
  for (const id of ['chat', 'spend', 'channels']) {
    assert.equal(where(c, id), 'hidden', id);
    assert.ok(!shown(c).includes(id), id);
  }
  assert.ok(shown(c).includes('agents-inbox'), 'the rest of the new default is shown');
});

test('every page of a group the owner hid stays hidden; the group flag itself is dropped', () => {
  const v1 = v1Default();
  v1.groups[4].hidden = true; // Analytics
  const c = migrate(v1);
  for (const id of ['analytics', 'spend', 'tracked']) assert.equal(where(c, id), 'hidden', id);
  assert.ok(c.groups.every((g) => !g.hidden));
  assert.equal(where(c, 'health'), 'g_analytics', 'health came from Home in v1, so it is shown');
});

test('a default-hidden page the owner showed in v1 stays visible', () => {
  const v1 = v1Default();
  v1.hidden = v1.hidden.filter((id) => id !== 'directives' && id !== 'bots' && id !== 'settings-security');
  v1.groups[1].items.push('directives');
  v1.groups[6].items.push('bots');
  v1.groups[8].items.push('settings-security');
  const c = migrate(v1);
  for (const id of ['directives', 'bots', 'settings-security']) assert.ok(shown(c).includes(id), id);
  assert.equal(where(c, 'directives'), 'g_agents');
  assert.equal(where(c, 'settings-security'), 'g_system');
  assert.equal(where(c, 'bots'), 'g_system', 'a page whose v1 group is gone goes to its v2 default group');
});

test('the Inbox, which v1 hid by default, is shown unless the owner showed it elsewhere', () => {
  const v1 = v1Default();
  assert.equal(where(migrate(v1), 'agents-inbox'), 'g_home');
  // The owner showed it in v1 (in Agents): the v2 default group keeps it in view.
  v1.hidden = v1.hidden.filter((id) => id !== 'agents-inbox');
  v1.groups[1].items.unshift('agents-inbox');
  assert.ok(shown(migrate(v1)).includes('agents-inbox'));
});

test('the owner groups, their titles and their order survive; their pages leave the built-in groups', () => {
  const v1 = v1Default();
  v1.groups.unshift({ id: 'g_c_daily', title: 'Daily', items: ['chat', 'logs'] });
  v1.groups.splice(5, 0, { id: 'g_c_money', title: 'Money', hidden: true, items: ['spend'] });
  v1.groups.push({ id: 'g_c_empty', title: 'Empty', items: [] });
  v1.groups[1].items = v1.groups[1].items.filter((id) => id !== 'chat'); // the owner moved chat out of Home
  const c = migrate(v1);
  assert.equal(c.groups[0].id, 'g_c_daily', 'first stays first');
  assert.deepEqual(c.groups[0].items, ['chat', 'logs']);
  const money = c.groups.find((g) => g.id === 'g_c_money')!;
  assert.deepEqual([money.title, money.hidden, money.items], ['Money', true, ['spend']]);
  assert.equal(c.groups.at(-1)!.id, 'g_c_empty');
  assert.equal(c.groups.filter((g) => g.items.includes('chat')).length, 1, 'a page is in one place only');
  assert.equal(c.groups.filter((g) => g.items.includes('spend')).length, 1);
  // The built-in groups after it are the v2 ones.
  assert.deepEqual(c.groups.filter((g) => !g.id.startsWith('g_c_')).map((g) => g.id), ['g_home', 'g_agents', 'g_analytics', 'g_system']);
});

test('a title the owner gave a surviving built-in group is kept; a lost group takes it along', () => {
  const v1 = v1Default();
  v1.groups[0].title = 'Start';
  v1.groups[2].title = 'Posting'; // Publishing no longer exists
  const c = migrate(v1);
  assert.equal(c.groups.find((g) => g.id === 'g_home')!.title, 'Start');
  assert.ok(!c.groups.some((g) => g.id === 'g_publishing'));
  const r = resolveNav(R, v1);
  assert.equal(r.groups[0].title, 'Start');
});

test('a stored title that is just the v1 built-in title is not a rename: the group takes its v2 title', () => {
  const v1 = v1Default();
  const titles: Record<string, string> = {
    g_home: 'Home', g_agents: 'Agents', g_publishing: 'Publishing', g_content: 'Content', g_analytics: 'Analytics',
    g_intelligence: 'Intelligence', g_connections: 'Connections', g_marketing: 'Marketing', g_system: 'System',
  };
  for (const g of v1.groups) g.title = titles[g.id];
  assert.deepEqual(migrate(v1), defaultConfig(), 'a menu saved with every title spelled out migrates to the v2 default');
  assert.deepEqual(resolveNav(R, v1).groups.map((g) => g.title), ['Home', 'Network', 'Insights', 'System']);
  v1.groups[1].title = 'My crew';
  assert.deepEqual(resolveNav(R, v1).groups.map((g) => g.title), ['Home', 'My crew', 'Insights', 'System']);
});

test('Today and Settings stay in the menu whatever v1 had (forced pages)', () => {
  const v1 = v1Default();
  v1.groups = [];
  v1.hidden = ['overview', 'settings', ...v1.hidden];
  const r = resolveNav(R, v1);
  const ids = r.groups.flatMap((g) => g.items.map((i) => i.id));
  assert.ok(ids.includes('overview') && ids.includes('settings'));
});

test('every menu page is placed exactly once after migrating a busy v1 menu', () => {
  const v1 = v1Default();
  v1.groups.unshift({ id: 'g_c_x', title: 'X', items: ['agents', 'compose', 'ghost-page'] });
  v1.groups[3].hidden = true;
  v1.hidden.push('models', 'nope');
  v1.pinned = ['agents', 'agents', 'ghost', 'c_1'];
  v1.custom = [{ id: 'c_1', label: 'One', icon: 'globe', to: '/app/logs' }];
  const c = migrate(v1);
  const all = [...c.groups.flatMap((g) => g.items), ...c.hidden];
  assert.equal(new Set(all).size, all.length, 'no duplicates');
  for (const e of menuEntries(R)) assert.ok(all.includes(e.id), `${e.id} is placed`);
});

test('odd shapes never throw and always give a complete menu', () => {
  const odd: unknown[] = [
    null, undefined, 'x', 7, [], [1, 2], {}, { schemaVersion: 1 },
    { schemaVersion: 1, groups: 'nope', pinned: 4, hidden: { a: 1 }, custom: 'x', overrides: [] },
    { schemaVersion: 1, groups: [null, 3, 'g', [], { id: 7 }, { id: 'g_home' }, { id: 'g_home', items: ['overview'] }, { id: 'g_x', items: [1, null, 'chat', {}] }], pinned: [1, 'chat', null], hidden: [3, 'spend', null], custom: [null, { id: 'c_1' }, { id: 'c_2', to: '/app/x' }, 'x'], overrides: { agents: 'x', chat: null, logs: { label: 5 } } },
    { schemaVersion: 1, groups: [{ id: 'g_home', items: 'overview', title: 5, hidden: 'yes' }], custom: [{ id: 'c_1', to: 3 }] },
  ];
  for (const bad of odd) {
    assert.doesNotThrow(() => migrateV1ToV2(bad, defaultConfig(), R), JSON.stringify(bad));
    const stored = bad && typeof bad === 'object' && !Array.isArray(bad) ? { ...(bad as object), schemaVersion: 1 } : { schemaVersion: 1 };
    const r = resolveNav(R, stored);
    assert.equal(r.source, 'saved', JSON.stringify(bad));
    const ids = r.groups.flatMap((g) => g.items.map((i) => i.id));
    assert.ok(ids.includes('overview') && ids.includes('settings'), JSON.stringify(bad));
    assert.equal(new Set(ids).size, ids.length, JSON.stringify(bad));
  }
});

test('a migration step that throws gives the default menu with a warning, not a crash', () => {
  const r = resolveNav(R, { schemaVersion: 1 }, { migrations: { 1: () => { throw new Error('boom'); } } });
  assert.equal(r.source, 'invalid');
  assert.match(r.warnings[0], /could not be upgraded/);
  assert.ok(r.groups.length > 0);
  // A step that returns garbage is handled the same way.
  assert.equal(resolveNav(R, { schemaVersion: 1 }, { migrations: { 1: () => 'x' } }).source, 'invalid');
});

test('a v2 menu is shown as saved, and a v3 menu is refused as newer', () => {
  assert.equal(resolveNav(R, defaultConfig()).source, 'saved');
  const r = resolveNav(R, { ...defaultConfig(), schemaVersion: 3 });
  assert.equal(r.source, 'newer');
  assert.match(r.warnings[0], /newer version/);
});
