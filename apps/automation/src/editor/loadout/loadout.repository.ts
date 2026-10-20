import type { Pool } from 'pg';

export type LoadoutMode = 'role' | 'custom';
export type LoadoutBy = 'owner' | 'creation' | 'recommend';

export interface LoadoutRow {
  toolName:  string;
  enabled:   boolean;
  createdBy: LoadoutBy;
  updatedAt: Date;
}

type Q = Pick<Pool, 'query'>;

/** agents.loadout_mode + agent_tools (spec 054 FR-001). */
export class LoadoutRepository {
  constructor(private readonly pool: Q) {}

  async mode(agentId: string): Promise<LoadoutMode> {
    const { rows } = await this.pool.query(`SELECT loadout_mode FROM agents WHERE id = $1`, [agentId]);
    return rows[0]?.loadout_mode === 'custom' ? 'custom' : 'role';
  }

  async rows(agentId: string): Promise<LoadoutRow[]> {
    const { rows } = await this.pool.query(
      `SELECT tool_name, enabled, created_by, updated_at FROM agent_tools WHERE agent_id = $1 ORDER BY tool_name`, [agentId]);
    return rows.map((r) => ({ toolName: r.tool_name, enabled: r.enabled, createdBy: r.created_by, updatedAt: r.updated_at }));
  }

  /** The enabled tool names, sorted: a stable order for the same loadout. */
  async enabledTools(agentId: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT tool_name FROM agent_tools WHERE agent_id = $1 AND enabled ORDER BY tool_name`, [agentId]);
    return rows.map((r) => r.tool_name as string);
  }

  /**
   * Sets the agent's loadout to exactly `names` and switches it to `custom`. Rows of tools that were switched off stay
   * (disabled), so the table remembers what the owner dropped; a row that was already there keeps its author.
   */
  async setTools(agentId: string, names: string[], by: LoadoutBy): Promise<void> {
    const keep = [...new Set(names)];
    if (keep.length) {
      await this.pool.query(
        `INSERT INTO agent_tools (agent_id, tool_name, enabled, created_by)
         SELECT $1, n, true, $3 FROM unnest($2::text[]) AS n
         ON CONFLICT (agent_id, tool_name) DO UPDATE
           SET enabled = true, updated_at = now(),
               created_by = CASE WHEN agent_tools.enabled THEN agent_tools.created_by ELSE EXCLUDED.created_by END`,
        [agentId, keep, by]);
    }
    await this.pool.query(
      `UPDATE agent_tools SET enabled = false, updated_at = now()
        WHERE agent_id = $1 AND enabled AND NOT (tool_name = ANY($2::text[]))`, [agentId, keep]);
    await this.pool.query(`UPDATE agents SET loadout_mode = 'custom' WHERE id = $1`, [agentId]);
  }

  /**
   * A loadout for an agent that has none: used when the agent is created. Does nothing when the agent already has a
   * custom loadout or rows, so a second sync never rewrites a loadout. Returns whether it wrote one.
   */
  async initTools(agentId: string, names: string[], by: LoadoutBy): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT (a.loadout_mode = 'custom') AS custom, EXISTS (SELECT 1 FROM agent_tools t WHERE t.agent_id = a.id) AS has_rows
         FROM agents a WHERE a.id = $1`, [agentId]);
    if (!rows[0] || rows[0].custom || rows[0].has_rows) return false;
    await this.setTools(agentId, names, by);
    return true;
  }

  /** Back to the role default: the mode and the rows. */
  async reset(agentId: string): Promise<void> {
    await this.pool.query(`DELETE FROM agent_tools WHERE agent_id = $1`, [agentId]);
    await this.pool.query(`UPDATE agents SET loadout_mode = 'role' WHERE id = $1`, [agentId]);
  }
}
