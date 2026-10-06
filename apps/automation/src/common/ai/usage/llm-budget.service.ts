import type { Pool } from 'pg';
import { kyivDay } from './kyiv-day';
import { BudgetExceededError, type BudgetGuard } from './llm-usage.service';
import type { LlmProvider } from './llm-prices.repository';
import {
  AGENTS_SCOPE, RESOURCE_DEFAULT_SCOPE, TOTAL_SCOPE,
  type BudgetRow, type BudgetSeed,
} from './llm-budgets.repository';

/** Start of the current Kyiv day as a timestamptz (index-friendly on llm_usage.at). */
export const KYIV_DAY_START_SQL = `(date_trunc('day', now() AT TIME ZONE 'Europe/Kyiv') AT TIME ZONE 'Europe/Kyiv')`;

export type CapScope = 'total' | 'global' | 'feature' | 'provider' | 'channel' | 'agent';

export interface BlockInfo {
  /** Verdict scope: total (all AI), global (the agents' editor.* cap), feature, provider, channel, agent. */
  scope:    CapScope;
  /** The llm_budgets scope key, channel key or agent id. */
  key:      string;
  label:    string;
  spentUsd: number;
  capUsd:   number;
}

export type FeatureVerdict = { ok: true } | ({ ok: false } & BlockInfo);

/** Env-derived default caps (spec 029 FR-008); they only seed llm_budgets. */
export interface CapDefaults {
  totalDailyUsd:    number;
  agentsDailyUsd:   number;
  resourceDailyUsd: number;
}

/** A numeric env var; an empty value means "use the default", never 0 (same rule as the editor's envNum). */
export function envNum(env: (k: string) => string | undefined, key: string, def: number): number {
  const v = env(key)?.trim();
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

/** Env defaults of the blocking caps (owner decision 2026-10-06); they only seed llm_budgets. */
export function capDefaults(env: (k: string) => string | undefined): CapDefaults {
  return {
    totalDailyUsd:    envNum(env, 'AI_DAILY_BUDGET_USD', 3),
    agentsDailyUsd:   envNum(env, 'EDITOR_DAILY_BUDGET_USD', 2),
    resourceDailyUsd: envNum(env, 'EDITOR_CHANNEL_DAILY_BUDGET_USD', 0.3),
  };
}

/** The seeds for llm_budgets from the env defaults. */
export function capSeeds(d: CapDefaults): BudgetSeed[] {
  return [
    { ...TOTAL_SCOPE,            dailyUsd: d.totalDailyUsd,    seededFrom: 'AI_DAILY_BUDGET_USD' },
    { ...AGENTS_SCOPE,           dailyUsd: d.agentsDailyUsd,   seededFrom: 'EDITOR_DAILY_BUDGET_USD' },
    { ...RESOURCE_DEFAULT_SCOPE, dailyUsd: d.resourceDailyUsd, seededFrom: 'EDITOR_CHANNEL_DAILY_BUDGET_USD' },
  ];
}

export interface LlmBudgetDeps {
  pool:      Pick<Pool, 'query'>;
  caps:      { list(): Promise<BudgetRow[]> };
  /** Persisted dedupe (llm_budget_alerts): one alert per scope and threshold per Kyiv day, also across restarts. */
  alertKeys: { claim(key: string): Promise<boolean> };
  /** Threshold (alert_pct) and alert-only alerts: plain Telegram. */
  alert:     (text: string) => Promise<void> | void;
  /** A blocking cap was hit: one Telegram alert + an Inbox `budget_blocked` entry. */
  blocked?:  (b: BlockInfo) => Promise<void> | void;
  /** Flush buffered ledger rows before reading spend. */
  flush?:    () => Promise<void>;
  log?:      (msg: string) => void;
  /** Caps are re-read after this long, so an owner edit applies without a restart (default 30 s). */
  capsTtlMs?: number;
  now?:      () => number;
}

const money = (n: number) => `$${n.toFixed(3)}`;

export function capLabel(row: Pick<BudgetRow, 'scopeKind' | 'scopeKey'>): string {
  if (row.scopeKind === 'global') return 'загальний ліміт AI (AI_DAILY_BUDGET_USD)';
  if (row.scopeKind === 'feature_prefix' && row.scopeKey === AGENTS_SCOPE.scopeKey) return 'ліміт агентів (EDITOR_DAILY_BUDGET_USD)';
  if (row.scopeKind === 'feature_prefix') return `ліміт ${row.scopeKey}*`;
  if (row.scopeKind === 'provider') return `ліміт провайдера ${row.scopeKey}`;
  return row.scopeKey === RESOURCE_DEFAULT_SCOPE.scopeKey ? 'ліміт ресурсу (EDITOR_CHANNEL_DAILY_BUDGET_USD)' : `ліміт ресурсу ${row.scopeKey}`;
}

function scopeOf(row: BudgetRow): CapScope {
  if (row.scopeKind === 'global') return 'total';
  if (row.scopeKind === 'feature_prefix') return row.scopeKey === AGENTS_SCOPE.scopeKey ? 'global' : 'feature';
  if (row.scopeKind === 'provider') return 'provider';
  return 'channel';
}

/**
 * Daily caps from llm_budgets (spec 029 FR-008), evaluated over llm_usage for
 * the Kyiv day. Every cap blocks unless its row has enforce = false. Alerts:
 * once at alert_pct and once at 100 % per scope per day (persisted keys), a
 * block also posts the Inbox entry. Work resumes at Kyiv midnight (the spend
 * window resets) or when the owner raises the cap (caps are re-read every
 * `capsTtlMs`). A failing check never blocks (fail open).
 */
export class LlmBudgetService implements BudgetGuard {
  private cached: BudgetRow[] | null = null;
  private cachedAt = 0;

  constructor(private readonly d: LlmBudgetDeps) {}

  private now(): number { return (this.d.now ?? Date.now)(); }

  invalidate(): void { this.cachedAt = 0; }

  async caps(): Promise<BudgetRow[]> {
    if (this.cached && this.now() - this.cachedAt < (this.d.capsTtlMs ?? 30_000)) return this.cached;
    try {
      this.cached = await this.d.caps.list();
      this.cachedAt = this.now();
    } catch (err: any) {
      this.d.log?.(`llm_budgets read failed: ${err?.message ?? err}`);
      if (!this.cached) return [];
    }
    return this.cached;
  }

  /** The daily cap of one resource: its own row, else the '*' default row (null = none). */
  async resourceCap(resourceRef: string): Promise<{ row: BudgetRow; capUsd: number } | null> {
    const rows = (await this.caps()).filter((r) => r.scopeKind === 'resource' && r.dailyUsd != null);
    const row = rows.find((r) => r.scopeKey === resourceRef) ?? rows.find((r) => r.scopeKey === RESOURCE_DEFAULT_SCOPE.scopeKey);
    return row ? { row, capUsd: row.dailyUsd! } : null;
  }

  /** Throws BudgetExceededError when a blocking cap covers this call; fails open on errors. */
  async assertWithin(feature: string, provider: LlmProvider): Promise<void> {
    let v: FeatureVerdict;
    try {
      v = await this.checkFeature(feature, provider);
    } catch (err: any) {
      this.d.log?.(`budget check failed (call proceeds): ${err?.message ?? err}`);
      return;
    }
    if (!v.ok) throw new BudgetExceededError(v.scope === 'total' || v.scope === 'global' ? v.scope : `${v.scope}:${v.key}`, v.spentUsd, v.capUsd);
  }

  /**
   * Evaluate the global, feature_prefix and provider caps covering
   * (feature, provider) against today's spend. Resource caps belong to the
   * editor channel check (BudgetService), not to this method.
   */
  async checkFeature(feature: string, provider: string): Promise<FeatureVerdict> {
    const rows = (await this.caps()).filter((r) => r.dailyUsd != null && (
      r.scopeKind === 'global'
      || (r.scopeKind === 'feature_prefix' && feature.startsWith(r.scopeKey))
      || (r.scopeKind === 'provider' && r.scopeKey === provider)));
    if (!rows.length) return { ok: true };

    await this.d.flush?.().catch(() => {});
    const { rows: spend } = await this.d.pool.query(
      `SELECT feature, provider, COALESCE(SUM(cost_usd), 0)::float8 AS usd
         FROM llm_usage WHERE at >= ${KYIV_DAY_START_SQL} GROUP BY 1, 2`);
    const day = kyivDay(new Date(this.now()));
    let block: FeatureVerdict = { ok: true };
    // Most specific first, so a block names the narrowest exhausted cap.
    const order = { provider: 0, feature_prefix: 1, resource: 2, global: 3 } as const;
    for (const row of [...rows].sort((a, b) => order[a.scopeKind] - order[b.scopeKind] || b.scopeKey.length - a.scopeKey.length)) {
      const spent = spend
        .filter((s: any) => row.scopeKind === 'global'
          || (row.scopeKind === 'feature_prefix' && String(s.feature).startsWith(row.scopeKey))
          || (row.scopeKind === 'provider' && s.provider === row.scopeKey))
        .reduce((sum: number, s: any) => sum + Number(s.usd), 0);
      const info: BlockInfo = { scope: scopeOf(row), key: row.scopeKey, label: capLabel(row), spentUsd: spent, capUsd: row.dailyUsd! };
      const hit = await this.thresholds(`${row.scopeKind}:${row.scopeKey}`, day, info, row.alertPct, row.enforce);
      if (hit && block.ok) block = { ok: false, ...info };
    }
    return block;
  }

  /**
   * Alert at alert_pct and at 100 % (once each per scope per day). Returns
   * true when the cap blocks (spent ≥ cap and enforce).
   */
  async thresholds(scopeKey: string, day: string, info: BlockInfo, alertPct = 80, enforce = true): Promise<boolean> {
    if (info.capUsd <= 0 && !enforce) return false;
    if (info.spentUsd >= info.capUsd) {
      if (await this.claim(`budget:${scopeKey}:100:${day}`)) {
        try {
          if (enforce && this.d.blocked) await this.d.blocked(info);
          else await this.d.alert(enforce
            ? `💸 Бюджет LLM вичерпано: ${info.label} — ${money(info.spentUsd)} із $${info.capUsd}. Виклики заблоковано до опівночі за Києвом або до підняття ліміту.`
            : `💸 Перевищено ${info.label}: ${money(info.spentUsd)} із $${info.capUsd} (лише сповіщення, виклики не блокуються).`);
        } catch { /* alerting never breaks the gate */ }
      }
      return enforce;
    }
    if (alertPct < 100 && info.spentUsd >= info.capUsd * alertPct / 100) {
      if (await this.claim(`budget:${scopeKey}:${alertPct}:${day}`)) {
        try { await this.d.alert(`⚠️ ${info.label}: витрачено ${money(info.spentUsd)} із $${info.capUsd} (${alertPct}%+) за сьогодні.`); } catch { /* never breaks the gate */ }
      }
    }
    return false;
  }

  private async claim(key: string): Promise<boolean> {
    try { return await this.d.alertKeys.claim(key); } catch (err: any) {
      this.d.log?.(`budget alert dedupe failed: ${err?.message ?? err}`);
      return false;
    }
  }
}
