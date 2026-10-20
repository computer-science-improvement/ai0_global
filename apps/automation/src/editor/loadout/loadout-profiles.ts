import type { EditorRole } from '../llm/llm.types';
import type { EditorTool } from '../harness/tool';
import { toToolSpec } from '../harness/tool';
import { EXECUTOR_DENY, PLATFORM_ONLY, TELEGRAM_ONLY } from '../roles/editor-runner.service';
import { ORCHESTRATOR_EXCLUDE, IDEA_REVIEW_TOOLS } from '../network/network-runner';
import { MANAGER_TOOLS } from '../manager/manager-runner';
import { roleOfKind, type Platform, type Agent } from '../agents/agent.types';

/**
 * Loadout profiles (spec 054 FR-003). Per role, the **core** tools: the ones every agent of the role needs — the tools
 * its workflow skill (editor-skills/editor-<role>-workflow.md) names, plus `load_skill`. The role's terminal tools are
 * core too (a run ends with one) but are not listed: they are read from the registry. Every other tool of the role is
 * optional. Profiles are code; a test checks that every name is a tool of that role in the real registry.
 */
export const CORE_TOOLS: Partial<Record<EditorRole, readonly string[]>> = {
  executor: ['load_skill', 'fetch_feed', 'fetch_api', 'web_fetch', 'library_catalog', 'query_data', 'check_similarity'],
  planner: [
    'load_skill', 'get_channel_stats', 'get_recent_posts', 'get_format_performance', 'get_resource_format', 'fetch_feed', 'fetch_api',
  ],
  reviewer: [
    'load_skill', 'get_channel_stats', 'get_format_performance', 'get_top_posts', 'get_channel_memory', 'sql_readonly',
    'add_memory', 'retire_memory', 'set_format_weights',
  ],
  orchestrator: [
    'load_skill', 'accept_directive', 'contest_directive', 'decline_advice', 'report_directive_done', 'list_directives',
    'add_idea', 'revise_idea', 'list_ideas', 'define_series', 'update_series', 'retire_series', 'set_series_active', 'list_series',
    'get_network_posts', 'get_platform_stats', 'get_network_highlights', 'get_resource_format', 'library_catalog',
    'fetch_feed', 'web_fetch',
  ],
  idea_reviewer: ['load_skill', 'review_ideas', 'review_playbook', 'get_playbook', 'list_ideas', 'web_fetch'],
  manager: [
    'load_skill', 'get_kpi_digest', 'file_directive', 'list_directives', 'explain_decision', 'get_network_posts', 'get_platform_stats',
    'sql_readonly',
  ],
  builder: [
    'load_skill', 'list_resources', 'inspect_resource', 'draft_resource_profile', 'set_resource_profile', 'set_brief', 'create_agent',
    'update_agent', 'list_agents', 'get_agent', 'write_skill', 'attach_skill', 'set_network_mode', 'propose_content_examples',
  ],
};

/** Roles an agent kind can have a loadout for (all of them: system agents and the resource agents). */
export const LOADOUT_ROLES: EditorRole[] = ['planner', 'executor', 'reviewer', 'orchestrator', 'idea_reviewer', 'manager', 'builder'];

/** What `GET …/loadout` needs of a tool, and nothing the registry holds only for running it. */
export type ToolInfo = Pick<EditorTool, 'name' | 'description' | 'kind' | 'roles' | 'chatOnly'>;

/** The tools a loadout covers for a role: the registry's tools of the role, without the chat-only ones. */
export function universeOf(role: EditorRole, tools: EditorTool[]): EditorTool[] {
  return tools.filter((t) => t.roles.includes(role) && !t.chatOnly);
}

/** Core tools of the role: the profile's names plus the role's terminal tools. */
export function coreOf(role: EditorRole, universe: ToolInfo[]): Set<string> {
  const named = new Set(CORE_TOOLS[role] ?? []);
  return new Set(universe.filter((t) => t.kind === 'terminal' || named.has(t.name)).map((t) => t.name));
}

/**
 * Tools that cannot be switched on for the role because its runs drop them whatever the loadout says
 * (the writer's EXECUTOR_DENY, the orchestrator's ORCHESTRATOR_EXCLUDE, the idea reviewer's short list).
 */
export function hardExcluded(role: EditorRole, universe: ToolInfo[]): Set<string> {
  switch (role) {
    case 'executor':      return new Set(EXECUTOR_DENY);
    case 'orchestrator':  return new Set(ORCHESTRATOR_EXCLUDE);
    case 'idea_reviewer': return new Set(universe.map((t) => t.name).filter((n) => !IDEA_REVIEW_TOOLS.has(n)));
    default:              return new Set();
  }
}

/**
 * The tools of a scheduled run when nobody narrowed them: the role's tools minus the hard exclusions. The manager's
 * scheduled review uses a short list (MANAGER_TOOLS) — its owner chat keeps the rest — so tokens count that list.
 */
export function roleDefaultOf<T extends ToolInfo>(role: EditorRole, universe: T[]): T[] {
  const out = hardExcluded(role, universe);
  return universe.filter((t) => !out.has(t.name) && (role !== 'manager' || MANAGER_TOOLS.has(t.name)));
}

/** The size of a tool's schema in tokens (spec 054 FR-004): a character count over four, like the spec's estimate. */
export function toolTokens(t: EditorTool): number {
  const s = toToolSpec(t);
  return Math.ceil(JSON.stringify({ name: s.name, description: s.description, input_schema: s.parameters }).length / 4);
}

export interface ResourceNeeds {
  /** The resource (or a member of its network) publishes to Telegram. */
  telegram: boolean;
  /** …to a platform other than Telegram. */
  platforms: boolean;
}

/** The share of its runs a peer must call a tool in for a new agent to start with it (FR-003). */
export const PEER_START_RATE = 0.2;
/** Fewer runs of peers than this say nothing (a lone agent's habit is not the role's). */
export const PEER_MIN_RUNS = 5;

/**
 * The enabled set of a new agent (FR-003): the core tools; the Telegram-only tools of a Telegram resource and the
 * platform tools of a resource with other platforms (the writer's lint/preview and publish tools — the same split the
 * runner applies per slot); and the tools its peers call often. Names outside the role's runnable set are dropped.
 */
export function creationLoadout(role: EditorRole, tools: EditorTool[], needs: ResourceNeeds, peers: string[]): string[] {
  const universe = universeOf(role, tools);
  const runnable = new Set(roleDefaultOf(role, universe).map((t) => t.name));
  const want = new Set<string>(coreOf(role, universe));
  for (const t of universe) {
    if (needs.telegram && TELEGRAM_ONLY.has(t.name)) want.add(t.name);
    if (needs.platforms && PLATFORM_ONLY.has(t.name)) want.add(t.name);
  }
  for (const n of peers) want.add(n);
  return universe.map((t) => t.name).filter((n) => want.has(n) && (runnable.has(n) || coreOf(role, universe).has(n)));
}

/** The platforms a new agent's resource publishes to: its own, plus the members of its network. */
export function needsOf(platforms: Platform[]): ResourceNeeds {
  return { telegram: platforms.includes('telegram'), platforms: platforms.some((p) => p !== 'telegram') };
}

/** The role an agent's loadout is for. */
export const loadoutRoleOf = (agent: Pick<Agent, 'kind'>): EditorRole => roleOfKind(agent.kind);
