// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 D4: More tools, the active item, group titles, the footer and the live pill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAV_REGISTRY } from './registry';
import { defaultNav, type ResolvedItem } from './model';
import { resolveNav, defaultConfig } from './resolve';
import { hideItem } from './ops';
import {
  activeItemId, initials, liveAgentCount, liveAgentsLabel, moreTools, pickGlobalBudget, showGroupTitle,
} from './sidebar-model';

const R = NAV_REGISTRY;
const ids = (xs: ResolvedItem[]) => xs.map((i) => i.id);
const item = (o: Partial<ResolvedItem> & { id: string; to: string }): ResolvedItem => ({ label: o.id, icon: 'globe', badge: null, ...o });

test('More tools: the hidden pages, without sub-views, in registry order', () => {
  const more = moreTools(defaultNav());
  assert.deepEqual(ids(more), [
    'dm-inbox', 'models', 'artifacts', 'scheduled', 'compose', 'editor', 'logs', 'data',
    'tracked', 'discovery', 'graph', 'recommendations',
    'connections', 'groups', 'landing', 'ads',
  ]);
  for (const sub of ['approvals', 'directives', 'bots', 'telegraph', 'connections-meta', 'connections-tiktok', 'settings-navigation', 'settings-security', 'settings-ai']) {
    assert.ok(!ids(more).includes(sub), `${sub} is a sub-view`);
  }
});

test('More tools: pages the owner hid join them, custom links come last, gone pages are left out', () => {
  const cfg = hideItem(defaultConfig(), 'spend');
  cfg.custom = [{ id: 'c_a', label: 'A', icon: 'globe', to: '/app/logs' }, { id: 'c_gone', label: 'Gone', icon: 'globe', to: '/app/gone' }];
  const r = resolveNav(R, cfg, { routeExists: (h) => !h.startsWith('/app/gone') });
  const more = moreTools(r);
  assert.ok(ids(more).includes('spend'));
  assert.deepEqual(ids(more).slice(-1), ['c_a'], 'a custom link is last');
  assert.ok(!ids(more).includes('c_gone'), 'a custom link whose route is gone is not offered');
  // The same page twice is listed once.
  assert.equal(ids(moreTools({ hidden: [item({ id: 'x', to: '/app/x' }), item({ id: 'x', to: '/app/x' })] })).length, 1);
});

test('active item: the longest prefix wins, so Inbox is not Agents', () => {
  const nav = defaultNav();
  const items = [...nav.groups.flatMap((g) => g.items), ...moreTools(nav)];
  assert.equal(activeItemId(items, '/app/agents/inbox'), 'agents-inbox');
  assert.equal(activeItemId(items, '/app/agents/inbox?tab=approvals'), 'agents-inbox');
  assert.equal(activeItemId(items, '/app/agents'), 'agents');
  assert.equal(activeItemId(items, '/app/agents/some-agent'), 'agents', 'a detail page belongs to its list');
  assert.equal(activeItemId(items, '/app/agents/'), 'agents', 'a trailing slash is ignored');
  assert.equal(activeItemId(items, '/app/channels?filter=mine'), 'channels');
  assert.equal(activeItemId(items, '/app/channels/@news?filter=mine&x=1#top'), 'channels');
  assert.equal(activeItemId(items, '/app/agentsx'), null, 'a prefix ends at a segment');
});

test('active item: Today matches /app only; unknown paths light nothing', () => {
  const items = defaultNav().groups.flatMap((g) => g.items);
  assert.equal(activeItemId(items, '/app'), 'overview');
  assert.equal(activeItemId(items, '/app/'), 'overview');
  assert.equal(activeItemId(items, '/app?foo=1'), 'overview');
  assert.equal(activeItemId(items, '/app/nowhere'), null);
  assert.equal(activeItemId([], '/app'), null);
});

test('active item: search values count, more keys win, a page without them still matches', () => {
  const plain = item({ id: 'settings', to: '/app/settings' });
  const sec = item({ id: 'security', to: '/app/settings', search: { tab: 'security' } });
  const both = item({ id: 'both', to: '/app/settings', search: { tab: 'security', x: '1' } });
  assert.equal(activeItemId([plain, sec], '/app/settings'), 'settings');
  assert.equal(activeItemId([plain, sec], '/app/settings?tab=security'), 'security');
  assert.equal(activeItemId([sec, plain], '/app/settings?tab=security'), 'security', 'order does not matter');
  assert.equal(activeItemId([plain, sec], '/app/settings?tab=ai'), 'settings');
  assert.equal(activeItemId([plain, sec, both], '/app/settings?tab=security&x=1'), 'both');
  assert.equal(activeItemId([sec], '/app/settings'), null, 'needs its search values');
});

test('active item: the router location object works the same, with parsed values', () => {
  const sec = item({ id: 'sec', to: '/app/settings', search: { tab: 'security', page: '2', on: 'true' } });
  const plain = item({ id: 'settings', to: '/app/settings' });
  assert.equal(activeItemId([plain, sec], { pathname: '/app/settings', search: { tab: 'security', page: 2, on: true } }), 'sec');
  assert.equal(activeItemId([plain, sec], { pathname: '/app/settings/', search: { tab: 'security' } }), 'settings');
  assert.equal(activeItemId([plain], { pathname: '/app/settings' }), 'settings');
  assert.equal(activeItemId([sec], { pathname: '/app/settings', search: { tab: { a: 1 } } }), null, 'objects never match');
});

test('active item: a page that no longer exists is never active; equal scores keep the first', () => {
  const gone = item({ id: 'gone', to: '/app/logs', unavailable: true });
  const a = item({ id: 'a', to: '/app/logs' });
  const b = item({ id: 'b', to: '/app/logs' });
  assert.equal(activeItemId([gone, a, b], '/app/logs'), 'a');
  assert.equal(activeItemId([gone], '/app/logs'), null);
});

test('group titles: Home has none when it opens the menu', () => {
  const home = { id: 'g_home', title: 'Home' };
  assert.equal(showGroupTitle(home, 0, false), false);
  assert.equal(showGroupTitle(home, 0, true), true, 'a Pinned block above keeps it');
  assert.equal(showGroupTitle(home, 2, false), true, 'only when it is first');
  assert.equal(showGroupTitle({ id: 'g_home', title: 'Start' }, 0, false), true, 'a title the owner chose stays');
  assert.equal(showGroupTitle({ id: 'g_agents', title: 'Network' }, 0, false), true);
});

test('initials', () => {
  assert.equal(initials('Valentyn'), 'VA');
  assert.equal(initials('  ada  lovelace '), 'AL');
  assert.equal(initials('Mary Jane Watson'), 'MW');
  // A non-Latin name, built from code points: the UI-language test bans Cyrillic literals in source.
  const hedgehog = String.fromCodePoint(0x407, 0x436, 0x430, 0x43a);
  assert.equal(initials(hedgehog), String.fromCodePoint(0x407, 0x416));
  assert.equal(initials(''), '?');
  assert.equal(initials(undefined), '?');
  assert.equal(initials('   '), '?');
});

test('budget card: the global row with a daily cap, else any global row, else none', () => {
  const rows = [
    { scopeKind: 'agent', dailyUsd: 1, id: 1 },
    { scopeKind: 'global', dailyUsd: null, id: 2 },
    { scopeKind: 'global', dailyUsd: 10, id: 3 },
  ];
  assert.equal(pickGlobalBudget(rows)?.id, 3);
  assert.equal(pickGlobalBudget(rows.filter((r) => r.id !== 3))?.id, 2);
  assert.equal(pickGlobalBudget(rows.filter((r) => r.scopeKind !== 'global')), null);
  assert.equal(pickGlobalBudget([]), null);
  assert.equal(pickGlobalBudget(undefined), null);
});

test('live pill: channels whose agent is in live mode', () => {
  const channels = [{ mode: 'live' }, { mode: 'approve' }, { mode: 'live' }, { mode: 'off' }, { mode: 'shadow' }];
  assert.equal(liveAgentCount(channels), 2);
  assert.equal(liveAgentCount([]), 0);
  assert.equal(liveAgentCount(undefined), 0);
  assert.equal(liveAgentsLabel(1), '1 agent live');
  assert.equal(liveAgentsLabel(5), '5 agents live');
});
