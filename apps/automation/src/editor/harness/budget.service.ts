import type { Pool } from 'pg';

export type BudgetVerdict =
  | { ok: true }
  | { ok: false; scope: 'channel' | 'global' | 'agent'; spentUsd: number; limitUsd: number };

/** A registry agent's own daily cap (spec 017), checked in addition to the channel and global caps. */
export interface AgentBudget {
  id:        string;
  handle?:   string;
  limitUsd?: number | null;
}

export interface BudgetGate {
  check(channelKey: string | null, channelLimitUsd?: number | null, agent?: AgentBudget | null): Promise<BudgetVerdict>;
}

export interface BudgetLimits {
  globalDailyUsd:  number;
  channelDailyUsd: number;
}

/**
 * Daily spend caps on editor LLM usage, checked BEFORE every LLM call.
 * "Daily" = the Europe/Kyiv calendar day. Spend is the sum of cost_usd of
 * finished runs plus the per-step cost of runs still in flight, so a long run
 * counts against the budget while it runs.
 */
export class BudgetService implements BudgetGate {
  private readonly alerted = new Set<string>();

  constructor(
    private readonly pool: Pool,
    private readonly limits: BudgetLimits,
    private readonly alert: (text: string) => Promise<void> | void = () => {},
  ) {}

  async check(channelKey: string | null, channelLimitUsd?: number | null, agent?: AgentBudget | null): Promise<BudgetVerdict> {
    const { rows } = await this.pool.query(
      `SELECT
         COALESCE(SUM(s.cost_usd), 0)                                      AS global_usd,
         COALESCE(SUM(s.cost_usd) FILTER (WHERE r.channel_key = $1), 0)    AS channel_usd,
         COALESCE(SUM(s.cost_usd) FILTER (WHERE r.agent_id = $2), 0)       AS agent_usd,
         (now() AT TIME ZONE 'Europe/Kyiv')::date::text                    AS day
       FROM editor_run_steps s
       JOIN editor_runs r ON r.id = s.run_id
       WHERE (r.started_at AT TIME ZONE 'Europe/Kyiv')::date = (now() AT TIME ZONE 'Europe/Kyiv')::date`,
      [channelKey, agent?.id ?? null],
    );
    const globalUsd  = Number(rows[0]?.global_usd ?? 0);
    const channelUsd = Number(rows[0]?.channel_usd ?? 0);
    const agentUsd   = Number(rows[0]?.agent_usd ?? 0);
    const day        = String(rows[0]?.day ?? '');

    if (globalUsd >= this.limits.globalDailyUsd) {
      await this.alertOnce(`global:${day}`, `💸 Editor: глобальний денний бюджет вичерпано ($${globalUsd.toFixed(3)} / $${this.limits.globalDailyUsd}). Агенти зупинені до кінця доби.`);
      return { ok: false, scope: 'global', spentUsd: globalUsd, limitUsd: this.limits.globalDailyUsd };
    }
    const channelLimit = channelLimitUsd ?? this.limits.channelDailyUsd;
    if (channelKey && channelUsd >= channelLimit) {
      await this.alertOnce(`channel:${channelKey}:${day}`, `💸 Editor: бюджет каналу ${channelKey} вичерпано ($${channelUsd.toFixed(3)} / $${channelLimit}).`);
      return { ok: false, scope: 'channel', spentUsd: channelUsd, limitUsd: channelLimit };
    }
    if (agent?.limitUsd != null && agentUsd >= agent.limitUsd) {
      await this.alertOnce(`agent:${agent.id}:${day}`, `💸 Агент @${agent.handle ?? agent.id}: денний бюджет вичерпано ($${agentUsd.toFixed(3)} / $${agent.limitUsd}).`);
      return { ok: false, scope: 'agent', spentUsd: agentUsd, limitUsd: agent.limitUsd };
    }
    return { ok: true };
  }

  private async alertOnce(key: string, text: string): Promise<void> {
    if (this.alerted.has(key)) return;
    this.alerted.add(key);
    try { await this.alert(text); } catch { /* alerting must never break the budget gate */ }
  }
}
