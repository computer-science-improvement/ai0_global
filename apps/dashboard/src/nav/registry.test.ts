// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 027 T2: the nav registry, the default menu and the breadcrumb trails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_GROUPS, NAV_GROUPS, NAV_REGISTRY, FORCED_IDS, parentChain, menuEntries } from './registry';
import { defaultNav, hrefOf } from './model';
import { buildCrumbs } from './crumbs';
import { fullPathsFromRouteTree, makeRouteMatcher, pathOf } from './routes';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const routePaths = fullPathsFromRouteTree(readFileSync(`${SRC}routeTree.gen.ts`, 'utf8'));
const routeExists = makeRouteMatcher(routePaths);

test('ids are unique, stable-looking slugs', () => {
  const ids = NAV_REGISTRY.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate id');
  for (const id of ids) assert.match(id, /^[a-z0-9_:-]{1,64}$/, id);
  for (const g of NAV_GROUPS) assert.match(g.id, /^g_[a-z]+$/);
});

test('every registry page is a real route (hidden ones too, so deep links keep working)', () => {
  assert.ok(routePaths.length > 30, 'parsed the route tree');
  for (const e of NAV_REGISTRY) assert.ok(routeExists(e.to), `${e.id} → ${e.to} has no route`);
  // Templates resolve with concrete params as well.
  assert.ok(routeExists('/app/agents/manager'));
  assert.ok(routeExists('/app/editor/run/123'));
  assert.equal(routeExists('/app/connections/instagram'), false, 'the $platform stub is gone');
  assert.equal(routeExists('/app/nope'), false);
});

test('parents exist, chains have no cycles, templates never reach a menu', () => {
  const ids = new Set(NAV_REGISTRY.map((e) => e.id));
  for (const e of NAV_REGISTRY) {
    if (e.parent) assert.ok(ids.has(e.parent), `${e.id}.parent=${e.parent}`);
    assert.ok(parentChain(e.id).length < 5);
    if (e.menu === false) assert.ok(e.to.includes('$'), `${e.id} is a template`);
    else assert.ok(!e.to.includes('$'), `${e.id} must be a concrete path`);
  }
  assert.ok(menuEntries().every((e) => e.menu !== false));
});

test('spec 078: the default menu has 11 items in Home, Network, Insights and System', () => {
  const nav = defaultNav();
  const shape = Object.fromEntries(nav.groups.map((g) => [g.title, g.items.map((i) => i.label)]));
  assert.deepEqual(shape, {
    Home: ['Today', 'Inbox', 'Chat'],
    Network: ['Agents', 'Calendar', 'Channels', 'Map'],
    Insights: ['Analytics', 'Spend', 'Health'],
    System: ['Settings'],
  });
  assert.equal(nav.groups.flatMap((g) => g.items).length, 11);
  assert.deepEqual(nav.pinned, []);
  // Inbox carries the combined counter (unread notes + posts to approve); Agents only the directives.
  const items = nav.groups.flatMap((g) => g.items);
  const byId = (id: string) => items.find((i) => i.id === id)!;
  assert.equal(byId('agents-inbox').badge, 'agentsInbox');
  assert.equal(hrefOf(byId('agents-inbox')), '/app/agents/inbox');
  assert.equal(byId('agents').badge, 'directives');
  for (const id of FORCED_IDS) assert.ok(items.some((i) => i.id === id && i.forced), id);
  // Everything else is hidden by default, not lost: it lives under "More tools" and in ⌘K.
  const hidden = nav.hidden.map((i) => i.id);
  for (const id of [
    'approvals', 'directives', 'dm-inbox', 'models', 'artifacts', 'compose', 'scheduled', 'editor', 'logs', 'data',
    'tracked', 'discovery', 'graph', 'recommendations', 'connections', 'groups', 'landing', 'ads',
    'connections-meta', 'connections-tiktok', 'bots', 'telegraph', 'settings-navigation', 'settings-security', 'settings-ai',
  ]) assert.ok(hidden.includes(id), id);
  assert.equal(hrefOf(nav.hidden.find((i) => i.id === 'directives')!), '/app/agents/manager?tab=directives');
  assert.equal(hrefOf(nav.hidden.find((i) => i.id === 'approvals')!), '/app/agents/inbox?tab=approvals');
});

test('spec 078: groups keep their ids, the five old ones are legacy, and every default group is live', () => {
  const byId = Object.fromEntries(NAV_GROUPS.map((g) => [g.id, g]));
  assert.equal(byId.g_agents.title, 'Network');
  assert.equal(byId.g_analytics.title, 'Insights');
  assert.deepEqual(NAV_GROUPS.filter((g) => g.legacy).map((g) => g.id), ['g_publishing', 'g_content', 'g_intelligence', 'g_connections', 'g_marketing']);
  assert.deepEqual(DEFAULT_GROUPS.map((g) => g.id), ['g_home', 'g_agents', 'g_analytics', 'g_system']);
  // "Restore" in Settings → Navigation lands a hidden page in its default group: none points at a legacy group.
  const legacy = new Set(NAV_GROUPS.filter((g) => g.legacy).map((g) => g.id));
  for (const e of NAV_REGISTRY) assert.ok(!legacy.has(e.defaultGroup), `${e.id} → ${e.defaultGroup}`);
  // Hidden pages sit in the group the redesign names for them.
  const groupOf = (id: string) => NAV_REGISTRY.find((e) => e.id === id)!.defaultGroup;
  for (const id of ['compose', 'scheduled', 'editor', 'logs', 'data']) assert.equal(groupOf(id), 'g_agents', id);
  for (const id of ['tracked', 'discovery', 'graph', 'recommendations']) assert.equal(groupOf(id), 'g_analytics', id);
  for (const id of ['connections', 'groups', 'landing', 'ads']) assert.equal(groupOf(id), 'g_system', id);
});

test('spec 078: registry order matches the IA, sub-views are flagged and the Agents counter is the directives', () => {
  const visible = menuEntries().filter((e) => !e.hiddenByDefault);
  assert.deepEqual(visible.map((e) => e.id), [
    'overview', 'agents-inbox', 'chat', 'agents', 'calendar', 'channels', 'network-map', 'analytics', 'spend', 'health', 'settings',
  ]);
  const sub = menuEntries().filter((e) => e.subview).map((e) => e.id).sort();
  assert.deepEqual(sub, ['approvals', 'bots', 'connections-meta', 'connections-tiktok', 'directives', 'settings-ai', 'settings-navigation', 'settings-security', 'telegraph']);
  assert.ok(sub.every((id) => NAV_REGISTRY.find((e) => e.id === id)!.hiddenByDefault), 'a sub-view is never in the default menu');
  assert.equal(NAV_REGISTRY.find((e) => e.id === 'agents')!.badge, 'directives');
  // Ids are never renamed: the handoff's names map onto the real ones.
  for (const id of ['agents-inbox', 'network-map', 'dm-inbox', 'approvals', 'calendar']) assert.ok(NAV_REGISTRY.some((e) => e.id === id), id);
  assert.equal(NAV_REGISTRY.filter((e) => e.id === 'calendar').length, 1);
});

test('breadcrumbs follow the parent chain, then the dynamic ancestors, with renamed labels', () => {
  assert.deepEqual(buildCrumbs('agent-detail').map((c) => c.label), ['Agents']);
  assert.deepEqual(buildCrumbs('meta-account').map((c) => [c.label, c.to, c.search]), [
    ['Connections', '/app/connections', undefined],
    ['Meta accounts', '/app/connections', { section: 'meta' }],
  ]);
  const run = buildCrumbs('editor-run', [{ label: '@space', to: '/app/editor/$channel', params: { channel: '@space' } }]);
  assert.deepEqual(run.map((c) => c.label), ['Editor', '@space']);
  assert.deepEqual(buildCrumbs('compose').map((c) => c.label), ['Scheduled']);
  assert.deepEqual(buildCrumbs('overview'), []);
  const renamed = buildCrumbs('agents-inbox', [], (e) => (e.id === 'agents' ? 'Team' : e.label));
  assert.deepEqual(renamed.map((c) => c.label), ['Team']);
});

test('the FR-013 detail pages render breadcrumbs and dropped their ad-hoc back links', () => {
  const pages = [
    'app.agents_.$handle.tsx', 'app.agents_.inbox.tsx', 'app.channels_.$id.tsx', 'app.editor_.$channel.tsx',
    'app.editor_.run.$id.tsx', 'app.editor_.slot.$id.tsx',
    'app.connections_.meta_.$accountId.tsx', 'app.connections_.groups.tsx', 'app.compose.tsx', 'app.data_.$key.tsx',
  ];
  for (const f of pages) {
    const code = readFileSync(`${SRC}routes/${f}`, 'utf8');
    assert.match(code, /useCrumbs\(/, `${f} uses useCrumbs`);
    assert.doesNotMatch(code, /← |Back to /, `${f} still has a back link`);
  }
});

test('AppSidebar has no menu literals', () => {
  const code = readFileSync(`${SRC}components/AppSidebar.tsx`, 'utf8');
  // A menu entry literal looks like `{ to: '/app/x', label: 'X', icon: … }`.
  assert.doesNotMatch(code, /to:\s*'\/app[^']*',\s*label:/);
  assert.doesNotMatch(code, /const GROUPS|interface NavItem/);
});

test('route matcher basics', () => {
  const m = makeRouteMatcher(['/app', '/app/agents/$handle', '/files/$']);
  assert.equal(pathOf('/app/x/?q=1#h'), '/app/x');
  assert.ok(m('/app/'));
  assert.ok(m('/app/agents/%40manager?tab=directives'));
  assert.ok(m('/files/a/b/c'));
  assert.equal(m('/app/agents'), false);
  assert.equal(m('/app/agents/a/b'), false);
  assert.equal(m('/app/agents/%E0%A4%A'), false, 'malformed escapes do not throw');
});
