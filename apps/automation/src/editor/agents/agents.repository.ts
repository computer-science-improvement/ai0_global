import type { Pool } from 'pg';
import type { Agent, AgentKind, AgentMode, AgentSchedule, AgentScope, AgentStatus } from './agent.types';

export function rowToAgent(r: any): Agent {
  return {
    id: r.id, kind: r.kind, scope: r.scope, scopeId: r.scope_id ?? null, parentId: r.parent_id ?? null,
    name: r.name, handle: r.handle, emoji: r.emoji ?? null, description: r.description ?? null,
    mode: r.mode, status: r.status, pausedUntil: r.paused_until ?? null,
    model: r.model ?? null, reasoningEffort: r.reasoning_effort ?? null,
    schedule: r.schedule ?? {}, dailyBudgetUsd: r.daily_budget_usd == null ? null : Number(r.daily_budget_usd),
    shadowUntil: r.shadow_until ?? null, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export interface NewAgent {
  kind:            AgentKind;
  scope:           AgentScope;
  scopeId:         string | null;
  parentId?:       string | null;
  name:            string;
  handle:          string;
  emoji?:          string | null;
  description?:    string | null;
  mode?:           AgentMode;
  schedule?:       AgentSchedule;
  dailyBudgetUsd?: number | null;
  model?:          string | null;
  shadowUntil?:    Date | null;
  createdBy:       Agent['createdBy'];
}

export interface AgentPatch {
  name?:            string;
  handle?:          string;
  emoji?:           string | null;
  description?:     string | null;
  mode?:            AgentMode;
  status?:          AgentStatus;
  pausedUntil?:     Date | null;
  model?:           string | null;
  reasoningEffort?: 'low' | 'medium' | 'high' | null;
  schedule?:        AgentSchedule;
  dailyBudgetUsd?:  number | null;
  shadowUntil?:     Date | null;
}

const COLS: Record<keyof AgentPatch, string> = {
  name: 'name', handle: 'handle', emoji: 'emoji', description: 'description', mode: 'mode', status: 'status',
  pausedUntil: 'paused_until', model: 'model', reasoningEffort: 'reasoning_effort', schedule: 'schedule',
  dailyBudgetUsd: 'daily_budget_usd', shadowUntil: 'shadow_until',
};

export const ALIAS_TTL_DAYS = 30;

type Q = Pick<Pool, 'query'>;

/** agents + agent_handle_aliases (spec 017). */
export class AgentsRepository {
  constructor(private readonly pool: Q) {}

  async list(): Promise<Agent[]> {
    const { rows } = await this.pool.query(`SELECT * FROM agents ORDER BY (parent_id IS NOT NULL), kind, handle`);
    return rows.map(rowToAgent);
  }

  async get(id: string): Promise<Agent | null> {
    const { rows } = await this.pool.query(`SELECT * FROM agents WHERE id = $1`, [id]);
    return rows[0] ? rowToAgent(rows[0]) : null;
  }

  /** By handle (case-insensitive, with or without "@"), falling back to an unexpired alias. */
  async getByHandle(handle: string): Promise<Agent | null> {
    const h = handle.replace(/^@/, '').toLowerCase();
    const { rows } = await this.pool.query(
      `SELECT a.* FROM agents a WHERE lower(a.handle) = $1
       UNION ALL
       SELECT a.* FROM agent_handle_aliases x JOIN agents a ON a.id = x.agent_id
        WHERE lower(x.handle) = $1 AND x.expires_at > now()
       LIMIT 1`, [h]);
    return rows[0] ? rowToAgent(rows[0]) : null;
  }

  async findTop(kind: AgentKind, scope: AgentScope, scopeId: string | null): Promise<Agent | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM agents WHERE parent_id IS NULL AND kind = $1 AND scope = $2 AND COALESCE(scope_id, '') = COALESCE($3, '')`,
      [kind, scope, scopeId]);
    return rows[0] ? rowToAgent(rows[0]) : null;
  }

  async findChild(parentId: string, kind: AgentKind): Promise<Agent | null> {
    const { rows } = await this.pool.query(`SELECT * FROM agents WHERE parent_id = $1 AND kind = $2`, [parentId, kind]);
    return rows[0] ? rowToAgent(rows[0]) : null;
  }

  async children(parentId: string): Promise<Agent[]> {
    const { rows } = await this.pool.query(`SELECT * FROM agents WHERE parent_id = $1 ORDER BY kind`, [parentId]);
    return rows.map(rowToAgent);
  }

  async handleTaken(handle: string, exceptId?: string | null): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM agents WHERE lower(handle) = lower($1) AND ($2::uuid IS NULL OR id <> $2)
       UNION ALL
       SELECT 1 FROM agent_handle_aliases WHERE lower(handle) = lower($1) AND expires_at > now() AND ($2::uuid IS NULL OR agent_id <> $2)
       LIMIT 1`, [handle, exceptId ?? null]);
    return rows.length > 0;
  }

  async allHandles(): Promise<Set<string>> {
    const { rows } = await this.pool.query(
      `SELECT lower(handle) AS h FROM agents UNION SELECT lower(handle) FROM agent_handle_aliases WHERE expires_at > now()`);
    return new Set(rows.map((r) => r.h as string));
  }

  async insert(a: NewAgent): Promise<Agent> {
    const { rows } = await this.pool.query(
      `INSERT INTO agents (kind, scope, scope_id, parent_id, name, handle, emoji, description, mode, schedule, daily_budget_usd, model, shadow_until, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [a.kind, a.scope, a.scopeId, a.parentId ?? null, a.name, a.handle, a.emoji ?? null, a.description ?? null,
        a.mode ?? 'shadow', JSON.stringify(a.schedule ?? {}), a.dailyBudgetUsd ?? null, a.model ?? null, a.shadowUntil ?? null, a.createdBy]);
    return rowToAgent(rows[0]);
  }

  /** Applies a patch; a handle change keeps the old handle as an alias for ALIAS_TTL_DAYS. */
  async update(id: string, p: AgentPatch): Promise<Agent | null> {
    const sets: string[] = [];
    const vals: unknown[] = [id];
    for (const [k, col] of Object.entries(COLS) as Array<[keyof AgentPatch, string]>) {
      if (p[k] === undefined) continue;
      const v = k === 'schedule' ? JSON.stringify(p[k]) : p[k];
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    }
    if (!sets.length) return this.get(id);
    const before = p.handle !== undefined ? await this.get(id) : null;
    const { rows } = await this.pool.query(
      `UPDATE agents SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, vals);
    if (!rows[0]) return null;
    if (before && p.handle && before.handle.toLowerCase() !== p.handle.toLowerCase()) {
      await this.pool.query(
        `INSERT INTO agent_handle_aliases (handle, agent_id, expires_at) VALUES ($1, $2, now() + ($3 || ' days')::interval)
         ON CONFLICT (handle) DO UPDATE SET agent_id = EXCLUDED.agent_id, expires_at = EXCLUDED.expires_at`,
        [before.handle.toLowerCase(), id, String(ALIAS_TTL_DAYS)]);
      // A handle taken back by its agent is no longer an alias of anyone.
      await this.pool.query(`DELETE FROM agent_handle_aliases WHERE lower(handle) = lower($1)`, [p.handle]);
    }
    return rowToAgent(rows[0]);
  }

  /** Today's spend and the last run per agent (for the tree view). */
  async activity(): Promise<Map<string, { spentTodayUsd: number; lastRunAt: Date | null; lastStatus: string | null; runsToday: number }>> {
    const { rows } = await this.pool.query(
      `SELECT a.id,
              COALESCE(SUM(r.cost_usd) FILTER (WHERE (r.started_at AT TIME ZONE 'Europe/Kyiv')::date = (now() AT TIME ZONE 'Europe/Kyiv')::date), 0)::float8 AS spent,
              COUNT(r.id) FILTER (WHERE (r.started_at AT TIME ZONE 'Europe/Kyiv')::date = (now() AT TIME ZONE 'Europe/Kyiv')::date)::int AS runs_today,
              MAX(r.started_at) AS last_at,
              (SELECT status FROM editor_runs x WHERE x.agent_id = a.id ORDER BY started_at DESC LIMIT 1) AS last_status
         FROM agents a
         LEFT JOIN editor_runs r ON r.agent_id = a.id AND r.started_at > now() - interval '30 days'
        GROUP BY a.id`);
    return new Map(rows.map((r) => [r.id, {
      spentTodayUsd: Number(r.spent), lastRunAt: r.last_at ?? null, lastStatus: r.last_status ?? null, runsToday: Number(r.runs_today),
    }]));
  }

  /** Link runs of the legacy (role, channel) shape to agents (idempotent). */
  async linkLegacyRuns(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE editor_runs r SET agent_id = c.id
         FROM agents o JOIN agents c ON c.parent_id = o.id
        WHERE r.agent_id IS NULL AND o.kind = 'orchestrator' AND o.scope = 'resource'
          AND o.scope_id = 'telegram:' || r.channel_key AND c.kind = r.role`);
    return rowCount ?? 0;
  }
}
