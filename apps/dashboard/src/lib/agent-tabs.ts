// The tabs of /app/agents/$handle (spec 078 D6, handoff section 6.1): 17 leaves in 5 groups.
// `?tab=` stays the LEAF key, so every old link keeps working; the group is derived from the leaf. A group with several
// visible leaves shows a second row of tabs. Pure: no React, node-tested (agent-tabs.test.ts enumerates every leaf).

import type { AgentKind } from '../api/agents';

/** Every `?tab=` value the agent page accepts, in the order the groups list them (`overview` has no `?tab=` in the URL). */
export const AGENT_TABS = [
  'overview',
  'plan', 'schedule', 'ideas', 'approvals',
  'playbook', 'skills', 'loadout', 'memory', 'artifacts',
  'history', 'inbox', 'effects', 'reviews', 'directives',
  'settings', 'promo',
] as const;
export type AgentTab = typeof AGENT_TABS[number];

export const AGENT_GROUPS = ['overview', 'content', 'brain', 'activity', 'settings'] as const;
export type AgentGroup = typeof AGENT_GROUPS[number];

export const GROUP_LABEL: Record<AgentGroup, string> = {
  overview: 'Overview', content: 'Content', brain: 'Brain', activity: 'Activity', settings: 'Settings',
};

/** The leaves of each group, in display order. */
export const LEAVES_OF: Record<AgentGroup, readonly AgentTab[]> = {
  overview: ['overview'],
  content:  ['plan', 'schedule', 'ideas', 'approvals'],
  brain:    ['playbook', 'skills', 'loadout', 'memory', 'artifacts'],
  activity: ['history', 'inbox', 'effects', 'reviews', 'directives'],
  settings: ['settings', 'promo'],
};

/** Owner-facing names of the leaves (the second row of tabs). `inbox` lists what @manager sent, not the owner's notes. */
export const TAB_LABEL: Record<AgentTab, string> = {
  overview: 'Overview',
  plan: 'Plan', schedule: 'Schedule', ideas: 'Ideas', approvals: 'Posts to approve',
  playbook: 'Playbook', skills: 'Skills', loadout: 'Loadout', memory: 'Memory', artifacts: 'Artifacts',
  history: 'History', inbox: 'From @manager', effects: 'In force now', reviews: 'Reviews', directives: 'Directives',
  settings: 'General', promo: 'Promo',
};

/** leaf → group, derived from LEAVES_OF so the two cannot drift. */
export const GROUP_OF = Object.fromEntries(
  AGENT_GROUPS.flatMap((g) => LEAVES_OF[g].map((t) => [t, g] as const)),
) as Record<AgentTab, AgentGroup>;

export const groupOf = (tab: AgentTab): AgentGroup => GROUP_OF[tab];

export function isAgentTab(v: unknown): v is AgentTab {
  return typeof v === 'string' && (AGENT_TABS as readonly string[]).includes(v);
}

// ── who sees which leaf ──────────────────────────────────────────────────────

/** What decides the visibility of a leaf: the agent's kind and whether it belongs to a network (an orchestrator or a role agent). */
export interface TabContext { kind: AgentKind; networked: boolean }

/** The agent's context from the API detail: `parent` is set for a role agent. */
export function tabContext(agent: { kind: AgentKind; parentId: string | null }, parent: unknown): TabContext {
  return { kind: agent.kind, networked: agent.kind === 'orchestrator' || (!!parent && agent.parentId != null) };
}

/** Plan, schedule, ideas, approvals, playbook, @manager's notes and promo belong to a network orchestrator and its role agents. */
export const NETWORK_TABS: readonly AgentTab[] = ['plan', 'schedule', 'ideas', 'approvals', 'playbook', 'inbox', 'promo'];
/** Reviews and directives are @manager's. */
export const MANAGER_TABS: readonly AgentTab[] = ['reviews', 'directives'];
/** What is in force (pauses, experiments, playbook versions a directive wrote) is an orchestrator's. */
export const ORCHESTRATOR_TABS: readonly AgentTab[] = ['effects'];

export function isTabVisible(tab: AgentTab, ctx: TabContext): boolean {
  if (NETWORK_TABS.includes(tab)) return ctx.networked;
  if (MANAGER_TABS.includes(tab)) return ctx.kind === 'manager';
  if (ORCHESTRATOR_TABS.includes(tab)) return ctx.kind === 'orchestrator';
  return true;
}

export function visibleLeaves(group: AgentGroup, ctx: TabContext): AgentTab[] {
  return LEAVES_OF[group].filter((t) => isTabVisible(t, ctx));
}

/** The groups that have at least one visible leaf (Overview and Settings always do). */
export function visibleGroups(ctx: TabContext): AgentGroup[] {
  return AGENT_GROUPS.filter((g) => visibleLeaves(g, ctx).length > 0);
}

/** Where a click on a group goes: its first visible leaf. */
export function firstLeaf(group: AgentGroup, ctx: TabContext): AgentTab {
  return visibleLeaves(group, ctx)[0] ?? 'overview';
}

/** A leaf the agent cannot show (a gated one, or none) falls back to Overview, like the page always did. */
export function resolveTab(raw: AgentTab | undefined, ctx: TabContext): AgentTab {
  return raw && isTabVisible(raw, ctx) ? raw : 'overview';
}

/** The `search` of a link to a leaf: Overview has no `?tab=`. */
export function tabSearch(tab: AgentTab): { tab?: AgentTab } {
  return tab === 'overview' ? {} : { tab };
}
