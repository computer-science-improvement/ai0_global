// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 027 FR-007/FR-008: link targets typed or captured in the constructor, and
// the manual scenario "add the directives board via Add current page" end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NAV_ID_RE, isSafeNavPath, newNavId, parseNavTarget } from './config';
import { NAV_REGISTRY } from './registry';
import { defaultConfig, resolveNav } from './resolve';
import { addCustomLink, hideItem, moveItem, setOverride, togglePin } from './ops';
import { fullPathsFromRouteTree, makeRouteMatcher } from './routes';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const routeExists = makeRouteMatcher(fullPathsFromRouteTree(readFileSync(`${SRC}routeTree.gen.ts`, 'utf8')));

test('parseNavTarget: internal pages with filters; everything else is refused', () => {
  assert.deepEqual(parseNavTarget(' /app/channels?filter=external&q=crypto '), { to: '/app/channels', search: { filter: 'external', q: 'crypto' } });
  assert.deepEqual(parseNavTarget('/app/agents/manager?tab=directives'), { to: '/app/agents/manager', search: { tab: 'directives' } });
  assert.deepEqual(parseNavTarget('https://dash.example.com/app/logs/'), { to: '/app/logs' });
  assert.deepEqual(parseNavTarget('/app/logs#top'), { to: '/app/logs' });
  for (const bad of ['', 'logs', '/login', 'https://evil.example/', '//evil.example/app', '/app/../login', '/app/x:y', 'javascript:alert(1)', '/app?' + 'k=v&'.repeat(11)]) {
    assert.equal(parseNavTarget(bad), null, bad);
  }
  assert.equal(isSafeNavPath('/app'), true);
});

test('new ids satisfy the server id rule', () => {
  for (let i = 0; i < 50; i++) {
    assert.match(newNavId('c_'), NAV_ID_RE);
    assert.match(newNavId('g_c_'), /^g_c_[a-z0-9]{8}$/);
  }
});

test('manual scenario: reorder, rename, hide, pin, add the directives board as "Directives"', () => {
  let c = defaultConfig();
  c = moveItem(c, 'chat', 'g_home', 1);
  c = setOverride(c, 'agents', { label: 'Team' });
  c = hideItem(c, 'strategies');
  c = togglePin(c, 'approvals');
  const target = parseNavTarget('/app/agents/manager?tab=directives')!;
  assert.ok(routeExists(target.to));
  c = addCustomLink(c, { id: 'c_directives', label: 'Directives', icon: 'agents', ...target }, 'g_agents');
  // What the server stores is what comes back: the menu persists through a reload.
  const reloaded = JSON.parse(JSON.stringify(c));
  const nav = resolveNav(NAV_REGISTRY, reloaded, { routeExists });
  const ids = nav.groups.flatMap((g) => g.items.map((i) => i.id));
  assert.deepEqual(nav.groups[0].items.map((i) => i.id), ['overview', 'chat', 'approvals']);
  assert.equal(nav.groups.flatMap((g) => g.items).find((i) => i.id === 'agents')!.label, 'Team');
  assert.ok(!ids.includes('strategies') && nav.hidden.some((i) => i.id === 'strategies'));
  assert.deepEqual(nav.pinned.map((i) => i.id), ['approvals']);
  const dir = nav.groups.find((g) => g.id === 'g_agents')!.items.at(-1)!;
  assert.deepEqual([dir.label, dir.to, dir.search, dir.custom, dir.unavailable], ['Directives', '/app/agents/manager', { tab: 'directives' }, true, undefined]);
  // Reset = no config → the FR-003 default again.
  const reset = resolveNav(NAV_REGISTRY, null);
  assert.deepEqual(reset.groups[0].items.map((i) => i.id), ['overview', 'approvals']);
  assert.ok(reset.groups.flatMap((g) => g.items).some((i) => i.id === 'strategies'));
});
