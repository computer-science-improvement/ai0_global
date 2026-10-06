// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 027 T2: the nav registry, the default menu and the breadcrumb trails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NAV_GROUPS, NAV_REGISTRY, FORCED_IDS, parentChain, menuEntries } from './registry';
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

test('the default menu is FR-003 plus Posts to approve, Data and Spend', () => {
  const nav = defaultNav();
  const shape = Object.fromEntries(nav.groups.map((g) => [g.title, g.items.map((i) => i.label)]));
  assert.deepEqual(shape, {
    Home: ['Overview', 'Posts to approve'],
    Agents: ['Agents', 'Chat', 'DM inbox'],
    Publishing: ['Compose', 'Scheduled', 'Editor', 'Logs', 'Strategies', 'My channels'],
    Content: ['Data'],
    Analytics: ['Analytics', 'Spend', 'Tracked'],
    Intelligence: ['Discovery', 'Graph', 'Recommendations'],
    Connections: ['Connections', 'Groups'],
    Marketing: ['Landing', 'Ads'],
    System: ['Settings'],
  });
  assert.deepEqual(nav.pinned, []);
  // The approvals counter is on by default and Overview/Settings are forced.
  const approvals = nav.groups[0].items[1];
  assert.equal(approvals.badge, 'approvals');
  assert.equal(hrefOf(approvals), '/app/agents/inbox?tab=approvals');
  for (const id of FORCED_IDS) assert.ok(nav.groups.some((g) => g.items.some((i) => i.id === id && i.forced)), id);
  // Registered-only pages are hidden by default, not lost.
  const hidden = nav.hidden.map((i) => i.id);
  for (const id of ['agents-inbox', 'directives', 'connections-meta', 'connections-tiktok', 'bots', 'telegraph', 'settings-security']) {
    assert.ok(hidden.includes(id), id);
  }
  assert.equal(hrefOf(nav.hidden.find((i) => i.id === 'directives')!), '/app/agents/manager?tab=directives');
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
    'app.editor_.run.$id.tsx', 'app.editor_.slot.$id.tsx', 'app.strategies_.new.tsx', 'app.strategies_.$id.tsx',
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
  assert.doesNotMatch(code, /to:\s*'\/app/);
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
