// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 D6 / B3.1: the 17 leaves of the agent page, their 5 groups, who sees which, and that every ?tab= link in the
// code (dashboard and the texts the backend writes) still lands on a leaf.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  AGENT_GROUPS, AGENT_TABS, GROUP_LABEL, GROUP_OF, LEAVES_OF, MANAGER_TABS, NETWORK_TABS, TAB_LABEL,
  firstLeaf, groupOf, isAgentTab, isTabVisible, resolveTab, tabContext, tabSearch, visibleGroups, visibleLeaves,
  type AgentTab, type TabContext,
} from './agent-tabs';

/** The 15 leaves the page had before the redesign: every one must still be accepted. */
const OLD_TABS = ['overview', 'approvals', 'reviews', 'directives', 'artifacts', 'skills', 'loadout', 'memory', 'history', 'playbook', 'schedule', 'ideas', 'plan', 'inbox', 'promo'];

const ORCHESTRATOR: TabContext = { kind: 'orchestrator', networked: true };
const ROLE: TabContext = { kind: 'planner', networked: true };
const MANAGER: TabContext = { kind: 'manager', networked: false };
const BUILDER: TabContext = { kind: 'builder', networked: false };
const AUDITOR: TabContext = { kind: 'auditor', networked: false };

test('every old ?tab= value is still a leaf; settings and effects are the new ones', () => {
  for (const t of OLD_TABS) assert.ok(isAgentTab(t), `${t} is still accepted`);
  assert.deepEqual([...AGENT_TABS].filter((t) => !OLD_TABS.includes(t)).sort(), ['effects', 'settings']);
  assert.equal(AGENT_TABS.length, 17);
  assert.equal(new Set(AGENT_TABS).size, AGENT_TABS.length, 'no leaf twice');
  assert.equal(isAgentTab('content'), false, 'a group name is not a leaf');
  assert.equal(isAgentTab(undefined), false);
  assert.equal(isAgentTab('Plan'), false);
});

test('every leaf is in exactly one group and has a label; every group has a label and a first leaf', () => {
  const listed = AGENT_GROUPS.flatMap((g) => LEAVES_OF[g]);
  assert.deepEqual([...listed].sort(), [...AGENT_TABS].sort(), 'the groups partition the leaves');
  for (const t of AGENT_TABS) {
    assert.ok(GROUP_OF[t], `${t} has a group`);
    assert.equal(groupOf(t), GROUP_OF[t]);
    assert.ok(LEAVES_OF[GROUP_OF[t]].includes(t), `${t} is listed in its group`);
    assert.ok(TAB_LABEL[t], `label of ${t}`);
  }
  for (const g of AGENT_GROUPS) {
    assert.ok(GROUP_LABEL[g], `label of ${g}`);
    assert.ok(LEAVES_OF[g].length > 0, `${g} has leaves`);
  }
  assert.deepEqual(LEAVES_OF.overview, ['overview']);
});

test('the handoff table: which leaf lives in which group', () => {
  const expect: Record<string, string[]> = {
    overview: ['overview'],
    content: ['plan', 'schedule', 'ideas', 'approvals'],
    brain: ['playbook', 'skills', 'loadout', 'memory', 'artifacts'],
    activity: ['history', 'inbox', 'effects', 'reviews', 'directives'],
    settings: ['settings', 'promo'],
  };
  for (const [g, leaves] of Object.entries(expect)) assert.deepEqual([...LEAVES_OF[g as keyof typeof LEAVES_OF]], leaves, g);
  assert.equal(groupOf('approvals'), 'content');
  assert.equal(groupOf('reviews'), 'activity');
  assert.equal(groupOf('promo'), 'settings');
});

test('an orchestrator sees every leaf except the manager ones', () => {
  const visible = AGENT_TABS.filter((t) => isTabVisible(t, ORCHESTRATOR));
  assert.deepEqual(visible.filter((t) => !MANAGER_TABS.includes(t)), AGENT_TABS.filter((t) => !MANAGER_TABS.includes(t)));
  for (const t of MANAGER_TABS) assert.equal(isTabVisible(t, ORCHESTRATOR), false, t);
  assert.deepEqual(visibleGroups(ORCHESTRATOR), ['overview', 'content', 'brain', 'activity', 'settings']);
  assert.deepEqual(visibleLeaves('activity', ORCHESTRATOR), ['history', 'inbox', 'effects']);
});

test('a role agent shows the network leaves of its orchestrator but not what is in force or the manager leaves', () => {
  for (const t of NETWORK_TABS) assert.equal(isTabVisible(t, ROLE), true, t);
  assert.equal(isTabVisible('effects', ROLE), false);
  for (const t of MANAGER_TABS) assert.equal(isTabVisible(t, ROLE), false, t);
  assert.deepEqual(visibleLeaves('activity', ROLE), ['history', 'inbox']);
});

test('@manager: no network leaves, its own reviews and directives', () => {
  for (const t of NETWORK_TABS) assert.equal(isTabVisible(t, MANAGER), false, t);
  assert.equal(isTabVisible('effects', MANAGER), false);
  assert.deepEqual(visibleLeaves('activity', MANAGER), ['history', 'reviews', 'directives']);
  assert.deepEqual(visibleLeaves('brain', MANAGER), ['skills', 'loadout', 'memory', 'artifacts']);
  assert.deepEqual(visibleLeaves('settings', MANAGER), ['settings'], 'a single leaf: no second row');
  assert.deepEqual(visibleGroups(MANAGER), ['overview', 'brain', 'activity', 'settings'], 'no Content group');
});

test('builder and sysadmin: Overview, Brain without the playbook, History, Settings', () => {
  for (const ctx of [BUILDER, AUDITOR]) {
    assert.deepEqual(visibleGroups(ctx), ['overview', 'brain', 'activity', 'settings']);
    assert.deepEqual(visibleLeaves('activity', ctx), ['history']);
    assert.deepEqual(visibleLeaves('brain', ctx), ['skills', 'loadout', 'memory', 'artifacts']);
  }
});

test('every group of every kind has a first leaf that is visible; clicking a group never lands on a hidden tab', () => {
  for (const ctx of [ORCHESTRATOR, ROLE, MANAGER, BUILDER, AUDITOR]) {
    for (const g of visibleGroups(ctx)) {
      const first = firstLeaf(g, ctx);
      assert.ok(isTabVisible(first, ctx), `${ctx.kind}: ${g} -> ${first}`);
      assert.equal(groupOf(first), g);
    }
    // a group with no visible leaf is not offered, and firstLeaf falls back to Overview
    for (const g of AGENT_GROUPS.filter((x) => !visibleGroups(ctx).includes(x))) assert.equal(firstLeaf(g, ctx), 'overview');
  }
});

test('resolveTab: a gated or missing leaf falls back to Overview, a visible one stays', () => {
  assert.equal(resolveTab(undefined, ORCHESTRATOR), 'overview');
  assert.equal(resolveTab('playbook', ORCHESTRATOR), 'playbook');
  assert.equal(resolveTab('playbook', MANAGER), 'overview');
  assert.equal(resolveTab('directives', ORCHESTRATOR), 'overview');
  assert.equal(resolveTab('directives', MANAGER), 'directives');
  assert.equal(resolveTab('effects', ROLE), 'overview');
  assert.equal(resolveTab('settings', MANAGER), 'settings');
  assert.equal(resolveTab('settings', BUILDER), 'settings');
  for (const ctx of [ORCHESTRATOR, ROLE, MANAGER, BUILDER, AUDITOR]) {
    for (const t of AGENT_TABS) assert.ok(isTabVisible(resolveTab(t, ctx), ctx), `${ctx.kind}: ${t}`);
  }
});

test('tabContext: an orchestrator and a role agent with a parent are networked, @manager is not', () => {
  assert.deepEqual(tabContext({ kind: 'orchestrator', parentId: null }, null), ORCHESTRATOR);
  assert.deepEqual(tabContext({ kind: 'planner', parentId: 'p1' }, { id: 'p1' }), ROLE);
  assert.deepEqual(tabContext({ kind: 'planner', parentId: null }, null), { kind: 'planner', networked: false }, 'a role agent without a parent is not networked');
  assert.deepEqual(tabContext({ kind: 'manager', parentId: null }, null), MANAGER);
});

test('tabSearch: Overview is the bare URL', () => {
  assert.deepEqual(tabSearch('overview'), {});
  assert.deepEqual(tabSearch('plan'), { tab: 'plan' });
});

// ── every ?tab= link in the code lands on a leaf ─────────────────────────────

const SRC = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) && !name.endsWith('.gen.ts')) out.push(p);
  }
  return out;
}

/** Tabs named on lines that link to an agent page (not the inbox, which has its own `?tab=`). */
function agentTabLinks(files: string[]): Array<{ file: string; tab: string }> {
  const found: Array<{ file: string; tab: string }> = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/\/app\/agents\/(?!inbox)/.test(line)) return;
      // a link may keep `search` on the next line
      const text = `${line}\n${lines[i + 1] ?? ''}`;
      for (const m of text.matchAll(/\btab(?:: '|=)([a-z]+)/g)) found.push({ file, tab: m[1] });
    });
  }
  return found;
}

test('every ?tab= link to an agent page in the dashboard names a leaf', () => {
  const links = agentTabLinks(walk(SRC));
  assert.ok(links.length >= 15, `the scan found the links (${links.length})`);
  for (const l of links) assert.ok(isAgentTab(l.tab), `${l.file.replace(SRC, '')}: ?tab=${l.tab}`);
  const names = new Set(links.map((l) => l.tab));
  // The agent's own Inbox leaf lost its only deep link with the old Overview network-health table (spec 078); the tab bar reaches it.
  for (const t of ['skills', 'loadout', 'memory', 'artifacts', 'playbook', 'directives', 'schedule', 'promo']) assert.ok(names.has(t), `${t} is linked somewhere`);
});

test('the links the backend writes into notes and maps name a leaf', { skip: !existsSync(join(REPO, 'apps/automation/src')) }, () => {
  const links = agentTabLinks(walk(join(REPO, 'apps/automation/src')));
  assert.ok(links.length >= 1, `the scan found backend links (${links.length})`);
  for (const l of links) assert.ok(isAgentTab(l.tab), `${l.file.replace(REPO, '')}: ?tab=${l.tab}`);
});

test('the route accepts exactly the leaves of this module', () => {
  const route = readFileSync(join(SRC, 'routes/app.agents_.$handle.tsx'), 'utf8');
  assert.match(route, /isAgentTab\(/, 'validateSearch uses isAgentTab');
  assert.doesNotMatch(route, /const TABS = \[/, 'no second copy of the leaf list');
  const tabs: AgentTab[] = [...AGENT_TABS];
  assert.ok(tabs.includes('settings'));
});
