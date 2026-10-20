import type { Pool } from 'pg';
import type { EditorRole } from '../llm/llm.types';

type Q = Pick<Pool, 'query'>;

/** The window every figure of the loadout covers (steps are kept 30 days by default, spec 054 "What exists"). */
export const USAGE_DAYS = 30;

export interface ToolUse {
  calls:      number;
  errors:     number;
  lastUsedAt: Date | null;
}

/** What one agent's runs of the last 30 days say about its tools and skills. */
export interface AgentUsage {
  /** Runs of the agent in the window. */
  runs:    number;
  /** Per tool: in how many runs it was offered (runs recorded before migration 087 say nothing). */
  offered: Map<string, number>;
  /** Per tool: calls, errors, last call. */
  tools:   Map<string, ToolUse>;
  /** Per tool: calls the harness refused because the tool was not offered (`tool_not_allowed`). */
  denied:  Map<string, number>;
  /** Per skill: `load_skill` calls and the last one. */
  loads:   Map<string, { loads: number; lastLoadedAt: Date | null }>;
}

export const emptyUsage = (): AgentUsage => ({ runs: 0, offered: new Map(), tools: new Map(), denied: new Map(), loads: new Map() });

/** The share of a role's runs that called each tool, over agents other than the ones named. */
export interface PeerRates {
  runs:  number;
  rates: Map<string, number>;
}

/**
 * The usage queries of the loadout (spec 054): one grouped query per section, over `editor_runs` and
 * `editor_run_steps` of the last `days` days. Read-only.
 */
export class LoadoutUsage {
  constructor(private readonly pool: Q) {}

  /** Usage per agent id; an agent with no runs gets an empty usage. */
  async forAgents(agentIds: string[], days = USAGE_DAYS): Promise<Map<string, AgentUsage>> {
    const out = new Map<string, AgentUsage>(agentIds.map((id) => [id, emptyUsage()]));
    if (!agentIds.length) return out;
    const get = (id: string) => out.get(id)!;

    const runs = await this.pool.query(
      `SELECT agent_id::text AS agent_id, count(*)::int AS runs FROM editor_runs
        WHERE agent_id = ANY($1::uuid[]) AND started_at >= now() - make_interval(days => $2) GROUP BY agent_id`, [agentIds, days]);
    for (const r of runs.rows) get(r.agent_id).runs = r.runs;

    const offered = await this.pool.query(
      `SELECT r.agent_id::text AS agent_id, t AS tool, count(*)::int AS runs
         FROM editor_runs r, unnest(r.tools_offered) AS t
        WHERE r.agent_id = ANY($1::uuid[]) AND r.started_at >= now() - make_interval(days => $2) AND r.tools_offered IS NOT NULL
        GROUP BY r.agent_id, t`, [agentIds, days]);
    for (const r of offered.rows) get(r.agent_id).offered.set(r.tool, r.runs);

    const tools = await this.pool.query(
      `SELECT r.agent_id::text AS agent_id, s.tool_name AS tool,
              count(*)::int AS calls, count(*) FILTER (WHERE s.is_error)::int AS errors, max(s.created_at) AS last_at,
              count(*) FILTER (WHERE s.output->>'error' = 'tool_not_allowed')::int AS denied
         FROM editor_run_steps s JOIN editor_runs r ON r.id = s.run_id
        WHERE r.agent_id = ANY($1::uuid[]) AND s.type = 'tool' AND s.tool_name IS NOT NULL AND s.created_at >= now() - make_interval(days => $2)
        GROUP BY r.agent_id, s.tool_name`, [agentIds, days]);
    for (const r of tools.rows) {
      // A refused call is not a use of the tool: it was not there.
      const used = r.calls - r.denied;
      if (r.denied > 0) get(r.agent_id).denied.set(r.tool, r.denied);
      if (used > 0) get(r.agent_id).tools.set(r.tool, { calls: used, errors: Math.max(r.errors - r.denied, 0), lastUsedAt: r.last_at });
    }

    const loads = await this.pool.query(
      `SELECT r.agent_id::text AS agent_id, s.input->>'name' AS skill, count(*)::int AS loads, max(s.created_at) AS last_at
         FROM editor_run_steps s JOIN editor_runs r ON r.id = s.run_id
        WHERE r.agent_id = ANY($1::uuid[]) AND s.type = 'tool' AND s.tool_name = 'load_skill' AND NOT s.is_error
          AND s.input->>'name' IS NOT NULL AND s.created_at >= now() - make_interval(days => $2)
        GROUP BY r.agent_id, s.input->>'name'`, [agentIds, days]);
    for (const r of loads.rows) get(r.agent_id).loads.set(r.skill, { loads: r.loads, lastLoadedAt: r.last_at });
    return out;
  }

  /**
   * How often the other agents of a role call each tool: the runs that called it over the role's runs, leaving out
   * `exceptAgentIds`. A refused call does not count.
   */
  async peerRates(role: EditorRole, exceptAgentIds: string[], days = USAGE_DAYS): Promise<PeerRates> {
    const total = await this.pool.query(
      `SELECT count(*)::int AS runs FROM editor_runs
        WHERE role = $1 AND agent_id IS NOT NULL AND NOT (agent_id = ANY($2::uuid[])) AND started_at >= now() - make_interval(days => $3)`,
      [role, exceptAgentIds, days]);
    const runs: number = total.rows[0]?.runs ?? 0;
    const rates = new Map<string, number>();
    if (!runs) return { runs, rates };
    const { rows } = await this.pool.query(
      `SELECT s.tool_name AS tool, count(DISTINCT r.id)::int AS runs
         FROM editor_run_steps s JOIN editor_runs r ON r.id = s.run_id
        WHERE r.role = $1 AND r.agent_id IS NOT NULL AND NOT (r.agent_id = ANY($2::uuid[])) AND r.started_at >= now() - make_interval(days => $3)
          AND s.type = 'tool' AND s.tool_name IS NOT NULL AND COALESCE(s.output->>'error', '') <> 'tool_not_allowed'
        GROUP BY s.tool_name`, [role, exceptAgentIds, days]);
    for (const r of rows) rates.set(r.tool, r.runs / runs);
    return { runs, rates };
  }

  /** Tools the other agents of a role call in at least `minRate` of their runs, given at least `minRuns` runs. */
  async peerTools(role: EditorRole, exceptAgentIds: string[], minRate: number, minRuns: number, days = USAGE_DAYS): Promise<string[]> {
    const { runs, rates } = await this.peerRates(role, exceptAgentIds, days);
    if (runs < minRuns) return [];
    return [...rates].filter(([, rate]) => rate >= minRate).map(([tool]) => tool).sort();
  }
}
