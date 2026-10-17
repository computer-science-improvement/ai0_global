import type { Pool } from 'pg';
import { currentLlmContext } from '../../common/ai/usage/llm-context';
import { KYIV_DAY_START_SQL, type BlockInfo, type FeatureVerdict, type LlmBudgetService } from '../../common/ai/usage/llm-budget.service';
import { kyivDay } from '../../common/ai/usage/kyiv-day';
import { isChatFeature } from '../../common/ai/usage/features';

export type BudgetVerdict =
  | { ok: true }
  | { ok: false; scope: 'channel' | 'global' | 'agent' | 'total' | 'feature' | 'provider' | 'reserve' | 'headroom'; spentUsd: number; limitUsd: number; key?: string };

/** Production editor spend: `editor.*` without owner chat turns (spec 040 FR-001). */
const PRODUCTION = `u.feature LIKE 'editor.%' AND u.feature <> 'editor.chat' AND u.feature NOT LIKE 'editor.chat.%'`;

/**
 * Spec 046 FR-005: the share of the agents' daily cap kept for the writer and the critic. Review 2: the manager spent
 * $1.10 of a $2 cap before noon and the next slots failed on budget. The roles below stop at (1 − reserve) of the
 * cap; the writer, the critic, the planner and owner-started runs may use all of it.
 */
export const DEFAULT_WRITER_RESERVE_PCT = 40;
export const RESERVE_YIELDING_FEATURES: readonly string[] = ['editor.manager', 'editor.orchestrator', 'editor.idea_reviewer', 'editor.reviewer'];

/** A registry agent's own daily cap (spec 017), checked in addition to the channel and global caps. */
export interface AgentBudget {
  id:        string;
  handle?:   string;
  limitUsd?: number | null;
}

/** Spec 046 FR-005: what one executor + critic run of a slot costs at most on Sonnet (review 2: ≈ $0.05–0.15). */
export const DEFAULT_RUN_HEADROOM_USD = 0.15;

/** Spec 046 FR-005: `headroomUsd` — also refuse when less than this is left under the agents' or the channel cap (a whole run must fit). */
export interface BudgetCheckOptions { headroomUsd?: number }

export interface BudgetGate {
  /** `provider`: the run's workspace (spec 038), for provider-scoped llm_budgets caps; default openrouter. */
  check(channelKey: string | null, channelLimitUsd?: number | null, agent?: AgentBudget | null, provider?: string, o?: BudgetCheckOptions): Promise<BudgetVerdict>;
}

export interface BudgetLimits {
  /** The agents' cap (`editor.*`) when no llm_budgets row is wired. */
  globalDailyUsd:  number;
  channelDailyUsd: number;
  /** Spec 046 FR-005: the writer's reserve in % of the agents' cap (default DEFAULT_WRITER_RESERVE_PCT; 0 = off). */
  writerReservePct?: number;
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

  async check(channelKey: string | null, channelLimitUsd?: number | null, agent?: AgentBudget | null, provider = 'openrouter', o: BudgetCheckOptions = {}): Promise<BudgetVerdict> {
    const feature = currentLlmContext().feature?.startsWith('editor.') ? currentLlmContext().feature! : 'editor.unknown';
    if (this.caps) {
      // Total, agents (editor.*) or chat (editor.chat), and any feature/provider caps covering this editor call.
      let v: FeatureVerdict = { ok: true };
      try { v = await this.caps.checkFeature(feature, provider); } catch { /* fail open: the editor caps below still apply */ }
      if (!v.ok) return { ok: false, scope: v.scope as Exclude<BudgetVerdict, { ok: true }>['scope'], spentUsd: v.spentUsd, limitUsd: v.capUsd,
        ...(v.scope === 'feature' || v.scope === 'provider' ? { key: v.key } : {}) };
    }
    // An owner chat turn (spec 040 FR-001) answers to the total and chat caps above and to its per-turn cap (AgentLoop);
    // the production caps below (agents, channel, agent) neither count nor block it.
    if (isChatFeature(feature)) return { ok: true };

    const { rows } = await this.pool.query(
      `SELECT
         COALESCE(SUM(u.cost_usd) FILTER (WHERE ${PRODUCTION}), 0)                       AS global_usd,
         COALESCE(SUM(u.cost_usd) FILTER (WHERE ${PRODUCTION} AND (r.channel_key = $1
           OR (u.run_id IS NULL AND u.resource_ref = 'telegram:' || $1))), 0)             AS channel_usd,
         COALESCE(SUM(u.cost_usd) FILTER (WHERE u.root_agent_id =
           (SELECT COALESCE(parent_id, id) FROM agents WHERE id = $2)
           AND u.feature <> 'editor.chat' AND u.feature NOT LIKE 'editor.chat.%'), 0)    AS agent_usd,
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

    // Spec 046 FR-005: the writer's reserve and the headroom of a whole run, both against the agents' cap.
    const agentsCap = await this.agentsCapUsd();
    if (agentsCap != null && agentsCap > 0) {
      const reservePct = Math.min(90, Math.max(0, this.limits.writerReservePct ?? DEFAULT_WRITER_RESERVE_PCT));
      const line = Math.round(agentsCap * (1 - reservePct / 100) * 10_000) / 10_000;
      if (reservePct > 0 && RESERVE_YIELDING_FEATURES.includes(feature) && globalUsd >= line) {
        return { ok: false, scope: 'reserve', spentUsd: globalUsd, limitUsd: line };
      }
      if (o.headroomUsd && agentsCap - globalUsd < o.headroomUsd) {
        return { ok: false, scope: 'headroom', spentUsd: globalUsd, limitUsd: agentsCap };
      }
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
      if (o.headroomUsd && enforce && channelLimit - channelUsd < o.headroomUsd) return { ok: false, scope: 'headroom', spentUsd: channelUsd, limitUsd: channelLimit };
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

  /** The agents' daily cap: the llm_budgets `editor.` row (owner-editable), else the env limit. */
  private async agentsCapUsd(): Promise<number | null> {
    if (!this.caps) return this.limits.globalDailyUsd;
    try {
      const r = (await this.caps.caps()).find((x) => x.scopeKind === 'feature_prefix' && x.scopeKey === 'editor.' && x.enforce);
      return r ? r.dailyUsd ?? null : null;
    } catch { return null; }
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
