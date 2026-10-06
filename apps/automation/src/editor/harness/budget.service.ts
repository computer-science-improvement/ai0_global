import type { Pool } from 'pg';
import { currentLlmContext } from '../../common/ai/usage/llm-context';
import { KYIV_DAY_START_SQL, type BlockInfo, type FeatureVerdict, type LlmBudgetService } from '../../common/ai/usage/llm-budget.service';
import { kyivDay } from '../../common/ai/usage/kyiv-day';

export type BudgetVerdict =
  | { ok: true }
  | { ok: false; scope: 'channel' | 'global' | 'agent' | 'total' | 'feature' | 'provider'; spentUsd: number; limitUsd: number };

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
  /** The agents' cap (`editor.*`) when no llm_budgets row is wired. */
  globalDailyUsd:  number;
  channelDailyUsd: number;
}

/**
 * Daily spend caps on editor LLM usage, checked BEFORE every LLM call.
 * "Daily" = the Europe/Kyiv calendar day. Spend is read from the llm_usage
 * ledger (spec 029), which the editor writes per LLM call and per paid tool
 * step, so a long run counts against the budget while it runs.
 *
 * With `caps` (production) the total AI cap, the agents' `editor.*` cap and any
 * other matching llm_budgets row come from the DB (owner-editable, no restart),
 * alerts are deduped through persisted keys and a block posts the Inbox entry.
 * Without it (unit tests) the env `limits` apply with in-memory alert dedupe.
 */
export class BudgetService implements BudgetGate {
  private readonly alerted = new Set<string>();

  constructor(
    private readonly pool: Pool,
    private readonly limits: BudgetLimits,
    private readonly alert: (text: string) => Promise<void> | void = () => {},
    private readonly caps?: LlmBudgetService,
  ) {}

  async check(channelKey: string | null, channelLimitUsd?: number | null, agent?: AgentBudget | null): Promise<BudgetVerdict> {
    if (this.caps) {
      // Total, agents (editor.*) and any feature/provider caps covering this editor call.
      const feature = currentLlmContext().feature?.startsWith('editor.') ? currentLlmContext().feature! : 'editor.unknown';
      let v: FeatureVerdict = { ok: true };
      try { v = await this.caps.checkFeature(feature, 'openrouter'); } catch { /* fail open: the editor caps below still apply */ }
      if (!v.ok) return { ok: false, scope: v.scope as Exclude<BudgetVerdict, { ok: true }>['scope'], spentUsd: v.spentUsd, limitUsd: v.capUsd };
    }

    const { rows } = await this.pool.query(
      `SELECT
         COALESCE(SUM(u.cost_usd) FILTER (WHERE u.feature LIKE 'editor.%'), 0)          AS global_usd,
         COALESCE(SUM(u.cost_usd) FILTER (WHERE u.feature LIKE 'editor.%' AND (r.channel_key = $1
           OR (u.run_id IS NULL AND u.resource_ref = 'telegram:' || $1))), 0)             AS channel_usd,
         COALESCE(SUM(u.cost_usd) FILTER (WHERE u.root_agent_id =
           (SELECT COALESCE(parent_id, id) FROM agents WHERE id = $2)), 0)                AS agent_usd,
         (now() AT TIME ZONE 'Europe/Kyiv')::date::text                                   AS day
       FROM llm_usage u
       LEFT JOIN editor_runs r ON r.id = u.run_id
       WHERE u.at >= ${KYIV_DAY_START_SQL}`,
      [channelKey, agent?.id ?? null],
    );
    const globalUsd  = Number(rows[0]?.global_usd ?? 0);
    const channelUsd = Number(rows[0]?.channel_usd ?? 0);
    const agentUsd   = Number(rows[0]?.agent_usd ?? 0);
    const day        = String(rows[0]?.day ?? kyivDay());

    if (!this.caps && globalUsd >= this.limits.globalDailyUsd) {
      await this.alertOnce(`global:${day}`, `💸 Editor: глобальний денний бюджет вичерпано ($${globalUsd.toFixed(3)} / $${this.limits.globalDailyUsd}). Агенти зупинені до кінця доби.`);
      return { ok: false, scope: 'global', spentUsd: globalUsd, limitUsd: this.limits.globalDailyUsd };
    }

    if (channelKey) {
      const resource = this.caps && channelLimitUsd == null ? await this.caps.resourceCap(`telegram:${channelKey}`) : null;
      const channelLimit = channelLimitUsd ?? resource?.capUsd ?? this.limits.channelDailyUsd;
      const enforce = resource ? resource.row.enforce : true;
      const info: BlockInfo = { scope: 'channel', key: channelKey, label: `ліміт ресурсу telegram:${channelKey}`, labelEn: `resource cap telegram:${channelKey}`, spentUsd: channelUsd, capUsd: channelLimit };
      const blocked = this.caps
        ? await this.caps.thresholds(`channel:${channelKey}`, day, info, resource?.row.alertPct ?? 80, enforce)
        : channelUsd >= channelLimit && (await this.alertOnce(`channel:${channelKey}:${day}`, `💸 Editor: бюджет каналу ${channelKey} вичерпано ($${channelUsd.toFixed(3)} / $${channelLimit}).`), true);
      if (blocked) return { ok: false, scope: 'channel', spentUsd: channelUsd, limitUsd: channelLimit };
    }

    if (agent?.limitUsd != null) {
      const info: BlockInfo = { scope: 'agent', key: agent.id, label: `ліміт агента @${agent.handle ?? agent.id}`, labelEn: `agent cap @${agent.handle ?? agent.id}`, spentUsd: agentUsd, capUsd: agent.limitUsd };
      const blocked = this.caps
        ? await this.caps.thresholds(`agent:${agent.id}`, day, info, 100, true)
        : agentUsd >= agent.limitUsd && (await this.alertOnce(`agent:${agent.id}:${day}`, `💸 Агент @${agent.handle ?? agent.id}: денний бюджет вичерпано ($${agentUsd.toFixed(3)} / $${agent.limitUsd}).`), true);
      if (blocked) return { ok: false, scope: 'agent', spentUsd: agentUsd, limitUsd: agent.limitUsd };
    }
    return { ok: true };
  }

  /** Feature-level caps (spec 029 FR-008) for callers outside the editor loop. */
  async checkFeature(feature: string, provider: string): Promise<FeatureVerdict> {
    return this.caps ? this.caps.checkFeature(feature, provider) : { ok: true };
  }

  private async alertOnce(key: string, text: string): Promise<void> {
    if (this.alerted.has(key)) return;
    this.alerted.add(key);
    try { await this.alert(text); } catch { /* alerting must never break the budget gate */ }
  }
}
