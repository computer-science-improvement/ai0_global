import type { Pool } from 'pg';

export type BudgetScopeKind = 'global' | 'feature_prefix' | 'provider' | 'resource';

/** One llm_budgets row. `daily_usd` null = no daily cap on this scope. */
export interface BudgetRow {
  id:         number;
  scopeKind:  BudgetScopeKind;
  scopeKey:   string;
  dailyUsd:   number | null;
  monthlyUsd: number | null;
  alertPct:   number;
  enforce:    boolean;
}

export interface BudgetSeed {
  scopeKind:  BudgetScopeKind;
  scopeKey:   string;
  dailyUsd:   number;
  seededFrom: string;
}

/** Scope keys of the caps seeded from env (FR-008). */
export const TOTAL_SCOPE  = { scopeKind: 'global',         scopeKey: ''        } as const;
export const AGENTS_SCOPE = { scopeKind: 'feature_prefix', scopeKey: 'editor.' } as const;
/** The default per-resource cap; a row with a concrete resource_ref overrides it for that resource. */
export const RESOURCE_DEFAULT_SCOPE = { scopeKind: 'resource', scopeKey: '*' } as const;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export class LlmBudgetsRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async list(): Promise<BudgetRow[]> {
    const { rows } = await this.pool.query(
      `SELECT id, scope_kind, scope_key, daily_usd, monthly_usd, alert_pct, enforce FROM llm_budgets ORDER BY id`);
    return rows.map((r: any) => ({
      id: Number(r.id), scopeKind: r.scope_kind, scopeKey: r.scope_key ?? '',
      dailyUsd: num(r.daily_usd), monthlyUsd: num(r.monthly_usd), alertPct: Number(r.alert_pct ?? 80), enforce: r.enforce !== false,
    }));
  }

  /**
   * Insert the env-derived caps once. An existing row is never touched, so
   * after the first boot the DB (edited by the owner) is the source of truth.
   */
  async seed(seeds: BudgetSeed[]): Promise<number> {
    let inserted = 0;
    for (const s of seeds) {
      const { rowCount } = await this.pool.query(
        `INSERT INTO llm_budgets (scope_kind, scope_key, daily_usd, seeded_from) VALUES ($1, $2, $3, $4)
         ON CONFLICT (scope_kind, scope_key) DO NOTHING`,
        [s.scopeKind, s.scopeKey, s.dailyUsd, s.seededFrom]);
      inserted += rowCount ?? 0;
    }
    return inserted;
  }
}

/**
 * Persisted "already alerted" keys (llm_budget_alerts). `claim` returns true
 * only for the first caller of a key, across workers and restarts.
 */
export class BudgetAlertKeys {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async claim(key: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO llm_budget_alerts (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`, [key]);
    return (rowCount ?? 0) > 0;
  }

  /** Keys older than `days` (they carry a Kyiv day, so they are never needed again). */
  async prune(days = 7): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM llm_budget_alerts WHERE created_at < now() - make_interval(days => $1::int)`, [days]);
    return rowCount ?? 0;
  }
}
