import type { Pool } from 'pg';
import { KYIV_DAY_START_SQL } from '../common/ai/usage/llm-budget.service';
import type { DayRange } from './spend-range';

export const GROUP_BYS = ['day', 'agent', 'role', 'resource', 'provider', 'model', 'feature', 'run'] as const;
export type GroupBy = typeof GROUP_BYS[number];
export const STACK_BYS = ['provider', 'feature'] as const;
export type StackBy = typeof STACK_BYS[number];
export type Source = 'rollup' | 'raw';

export interface SpendFilters {
  /** A root agent id, or 'none' for calls without an agent. */
  agent?:    string;
  /** Feature prefix ('editor.', 'strategy.recipes'). */
  feature?:  string;
  provider?: string;
  shadow?:   boolean;
}

/** One aggregated row (a group, or the totals). */
export interface Agg {
  key:           string;
  calls:         number;
  errors:        number;
  tokensIn:      number;
  tokensOut:     number;
  tokensCached:  number;
  costUsd:       number;
  estimatedUsd:  number;
  unpricedCalls: number;
  shadowUsd:     number;
  /** Raw source only (the rollup keeps no latency). */
  avgLatencyMs:  number | null;
  /** Calls the provider returned no usage for (raw source only). */
  noUsageCalls:  number | null;
}

export interface DailyPart { day: string; stack: string; usd: number }

/** Today's spend split by everything a cap can match (feature, provider, resource, root agent). */
export interface SpendSlice { feature: string; provider: string; resourceRef: string | null; rootAgentId: string | null; usd: number }

export interface AgentCapRow { id: string; handle: string; capUsd: number; spentUsd: number }

export interface RawUsageRow {
  id: number; at: string; provider: string; model: string; kind: string; feature: string;
  rootAgentId: string | null; agentHandle: string | null; role: string | null; runId: string | null; stepIdx: number | null;
  resourceRef: string | null; tokensIn: number | null; tokensOut: number | null; tokensCachedRead: number | null;
  tokensCachedWrite: number | null; costUsd: number | null; costSource: string; latencyMs: number | null;
  attempts: number; status: string; errorCode: string | null; shadow: boolean;
}

export interface RepriceCandidate {
  id: number; provider: string; model: string; kind: string; at: Date; status: string;
  tokensIn: number | null; tokensOut: number | null; tokensCachedRead: number | null; tokensCachedWrite: number | null;
  costUsd: number | null; costSource: string;
}

/** Raw rows in a Kyiv-day range: index-friendly bounds on llm_usage.at. */
const RAW_WINDOW = `at >= ($1::date::timestamp AT TIME ZONE 'Europe/Kyiv') AND at < (($2::date + 1)::timestamp AT TIME ZONE 'Europe/Kyiv')`;
const ROLLUP_WINDOW = `day BETWEEN $1::date AND $2::date`;

const KEY_SQL: Record<GroupBy, Record<Source, string>> = {
  day:      { raw: `((at AT TIME ZONE 'Europe/Kyiv')::date)::text`, rollup: `day::text` },
  agent:    { raw: `COALESCE(root_agent_id::text, '')`, rollup: `COALESCE(root_agent_id::text, '')` },
  role:     { raw: `COALESCE(role, '')`, rollup: `COALESCE(role, '')` },
  resource: { raw: `COALESCE(resource_ref, '')`, rollup: `COALESCE(resource_ref, '')` },
  provider: { raw: `provider`, rollup: `provider` },
  model:    { raw: `model`, rollup: `model` },
  feature:  { raw: `feature`, rollup: `feature` },
  run:      { raw: `COALESCE(run_id::text, '')`, rollup: `''` },
};

const STACK_SQL: Record<StackBy, string> = {
  provider: `provider`,
  // Feature family (editor, strategy, dm, …) keeps the stack readable.
  feature:  `split_part(feature, '.', 1)`,
};

const AGG_SQL: Record<Source, string> = {
  raw: `COUNT(*)::bigint AS calls, (COUNT(*) FILTER (WHERE status <> 'ok'))::bigint AS errors,
        COALESCE(SUM(tokens_in), 0)::bigint AS tokens_in, COALESCE(SUM(tokens_out), 0)::bigint AS tokens_out,
        COALESCE(SUM(tokens_cached_read), 0)::bigint AS tokens_cached,
        COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd,
        COALESCE(SUM(cost_usd) FILTER (WHERE cost_source = 'estimate'), 0)::float8 AS estimated_usd,
        (COUNT(*) FILTER (WHERE cost_source = 'unpriced'))::bigint AS unpriced_calls,
        COALESCE(SUM(cost_usd) FILTER (WHERE shadow), 0)::float8 AS shadow_usd,
        AVG(latency_ms)::float8 AS avg_latency_ms,
        (COUNT(*) FILTER (WHERE tokens_in IS NULL AND tokens_out IS NULL))::bigint AS no_usage_calls`,
  rollup: `COALESCE(SUM(calls), 0)::bigint AS calls, COALESCE(SUM(errors), 0)::bigint AS errors,
        COALESCE(SUM(tokens_in), 0)::bigint AS tokens_in, COALESCE(SUM(tokens_out), 0)::bigint AS tokens_out,
        COALESCE(SUM(tokens_cached), 0)::bigint AS tokens_cached,
        COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd, COALESCE(SUM(estimated_usd), 0)::float8 AS estimated_usd,
        COALESCE(SUM(unpriced_calls), 0)::bigint AS unpriced_calls, COALESCE(SUM(shadow_usd), 0)::float8 AS shadow_usd,
        NULL::float8 AS avg_latency_ms, NULL::bigint AS no_usage_calls`,
};

const n = (v: unknown) => Number(v ?? 0);
const nn = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toAgg(r: any): Agg {
  return {
    key: String(r.key ?? ''), calls: n(r.calls), errors: n(r.errors), tokensIn: n(r.tokens_in), tokensOut: n(r.tokens_out),
    tokensCached: n(r.tokens_cached), costUsd: n(r.cost_usd), estimatedUsd: n(r.estimated_usd), unpricedCalls: n(r.unpriced_calls),
    shadowUsd: n(r.shadow_usd), avgLatencyMs: r.avg_latency_ms == null ? null : Math.round(Number(r.avg_latency_ms)), noUsageCalls: nn(r.no_usage_calls),
  };
}

/** LIKE pattern of a prefix with %, _ and \ escaped. */
export function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** WHERE fragments for the filters; params continue after the two range params. */
export function filterSql(f: SpendFilters, source: Source, params: unknown[]): string {
  const parts: string[] = [];
  if (f.agent === 'none') parts.push('root_agent_id IS NULL');
  else if (f.agent) { params.push(f.agent); parts.push(`root_agent_id = $${params.length}::uuid`); }
  if (f.feature) { params.push(likePrefix(f.feature)); parts.push(`feature LIKE $${params.length}`); }
  if (f.provider) { params.push(f.provider); parts.push(`provider = $${params.length}`); }
  if (f.shadow && source === 'raw') parts.push('shadow');
  return parts.length ? ` AND ${parts.join(' AND ')}` : '';
}

/**
 * Read side of the spend reports (spec 029 FR-010/FR-011): aggregates over the
 * raw ledger (llm_usage) or the Kyiv-day rollup (llm_usage_daily), and the
 * price and budget tables. No prompt or output text is ever read.
 */
export class SpendRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async aggregate(source: Source, r: DayRange, groupBy: GroupBy | null, f: SpendFilters, limit = 1000): Promise<Agg[]> {
    const params: unknown[] = [r.from, r.to];
    const where = (source === 'raw' ? RAW_WINDOW : ROLLUP_WINDOW) + filterSql(f, source, params);
    const table = source === 'raw' ? 'llm_usage' : 'llm_usage_daily';
    if (!groupBy) {
      const { rows } = await this.pool.query(`SELECT '' AS key, ${AGG_SQL[source]} FROM ${table} WHERE ${where}`, params);
      return rows.map(toAgg);
    }
    params.push(limit);
    const order = groupBy === 'day' ? 'key ASC' : 'cost_usd DESC, calls DESC, key ASC';
    const { rows } = await this.pool.query(
      `SELECT ${KEY_SQL[groupBy][source]} AS key, ${AGG_SQL[source]} FROM ${table} WHERE ${where}
        GROUP BY 1 ORDER BY ${order} LIMIT $${params.length}`, params);
    return rows.map(toAgg);
  }

  async daily(source: Source, r: DayRange, stackBy: StackBy, f: SpendFilters): Promise<DailyPart[]> {
    const params: unknown[] = [r.from, r.to];
    const where = (source === 'raw' ? RAW_WINDOW : ROLLUP_WINDOW) + filterSql(f, source, params);
    const table = source === 'raw' ? 'llm_usage' : 'llm_usage_daily';
    const { rows } = await this.pool.query(
      `SELECT ${KEY_SQL.day[source]} AS day, ${STACK_SQL[stackBy]} AS stack, COALESCE(SUM(cost_usd), 0)::float8 AS usd
         FROM ${table} WHERE ${where} GROUP BY 1, 2 ORDER BY 1, 2`, params);
    return rows.map((x: any) => ({ day: String(x.day), stack: String(x.stack), usd: n(x.usd) }));
  }

  /** Rollup totals per day from `from` (for the summary periods and their Δ). */
  async rollupByDay(from: string): Promise<Array<Agg & { day: string }>> {
    const { rows } = await this.pool.query(
      `SELECT day::text AS key, ${AGG_SQL.rollup} FROM llm_usage_daily WHERE day >= $1::date GROUP BY 1 ORDER BY 1`, [from]);
    return rows.map((x: any) => ({ ...toAgg(x), day: String(x.key) }));
  }

  /** Raw rows of a range for the CSV export, keyset-paginated by id. */
  async rawPage(r: DayRange, f: SpendFilters, afterId: number, limit: number): Promise<RawUsageRow[]> {
    const params: unknown[] = [r.from, r.to];
    const where = RAW_WINDOW + filterSql(f, 'raw', params);
    params.push(afterId, limit);
    const { rows } = await this.pool.query(
      `SELECT id, at, provider, model, kind, feature, root_agent_id, agent_handle, role, run_id, step_idx, resource_ref,
              tokens_in, tokens_out, tokens_cached_read, tokens_cached_write, cost_usd::float8 AS cost_usd, cost_source,
              latency_ms, attempts, status, error_code, shadow
         FROM llm_usage WHERE ${where} AND id > $${params.length - 1} ORDER BY id LIMIT $${params.length}`, params);
    return rows.map((x: any) => ({
      id: Number(x.id), at: new Date(x.at).toISOString(), provider: x.provider, model: x.model, kind: x.kind, feature: x.feature,
      rootAgentId: x.root_agent_id ?? null, agentHandle: x.agent_handle ?? null, role: x.role ?? null, runId: x.run_id ?? null,
      stepIdx: nn(x.step_idx), resourceRef: x.resource_ref ?? null, tokensIn: nn(x.tokens_in), tokensOut: nn(x.tokens_out),
      tokensCachedRead: nn(x.tokens_cached_read), tokensCachedWrite: nn(x.tokens_cached_write), costUsd: nn(x.cost_usd),
      costSource: x.cost_source, latencyMs: nn(x.latency_ms), attempts: Number(x.attempts ?? 1), status: x.status,
      errorCode: x.error_code ?? null, shadow: !!x.shadow,
    }));
  }

  /** Handles of root agents by id (deleted agents are simply missing). */
  async agentHandles(ids: string[]): Promise<Map<string, string>> {
    const valid = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (!valid.length) return new Map();
    const { rows } = await this.pool.query(`SELECT id::text AS id, handle FROM agents WHERE id = ANY($1::uuid[])`, [valid]);
    return new Map(rows.map((x: any) => [x.id, x.handle]));
  }

  /** Today's (Kyiv) spend by every dimension a cap can match, from the raw ledger (live, not the rollup). */
  async todaySlices(): Promise<SpendSlice[]> {
    const { rows } = await this.pool.query(
      `SELECT feature, provider, resource_ref, root_agent_id::text AS root_agent_id, COALESCE(SUM(cost_usd), 0)::float8 AS usd
         FROM llm_usage WHERE at >= ${KYIV_DAY_START_SQL} GROUP BY 1, 2, 3, 4`);
    return rows.map((x: any) => ({ feature: x.feature, provider: x.provider, resourceRef: x.resource_ref ?? null, rootAgentId: x.root_agent_id ?? null, usd: n(x.usd) }));
  }

  /** This month's spend before today (rollup) by the cap dimensions; today comes from todaySlices(). */
  async monthSlicesBeforeToday(): Promise<SpendSlice[]> {
    const { rows } = await this.pool.query(
      `SELECT feature, provider, resource_ref, root_agent_id::text AS root_agent_id, COALESCE(SUM(cost_usd), 0)::float8 AS usd
         FROM llm_usage_daily
        WHERE day >= date_trunc('month', (now() AT TIME ZONE 'Europe/Kyiv'))::date
          AND day < (now() AT TIME ZONE 'Europe/Kyiv')::date
        GROUP BY 1, 2, 3, 4`);
    return rows.map((x: any) => ({ feature: x.feature, provider: x.provider, resourceRef: x.resource_ref ?? null, rootAgentId: x.root_agent_id ?? null, usd: n(x.usd) }));
  }

  /** Agents with their own daily cap (spec 017) and their root's spend today. */
  async agentCaps(): Promise<AgentCapRow[]> {
    const { rows } = await this.pool.query(
      `SELECT a.id::text AS id, a.handle, a.daily_budget_usd::float8 AS cap,
              COALESCE((SELECT SUM(u.cost_usd) FROM llm_usage u
                         WHERE u.root_agent_id = COALESCE(a.parent_id, a.id) AND u.at >= ${KYIV_DAY_START_SQL}), 0)::float8 AS spent
         FROM agents a WHERE a.daily_budget_usd IS NOT NULL ORDER BY a.handle`);
    return rows.map((x: any) => ({ id: x.id, handle: x.handle, capUsd: n(x.cap), spentUsd: n(x.spent) }));
  }

  // ── prices ──────────────────────────────────────────────────────────────

  async listPrices(): Promise<any[]> {
    const { rows } = await this.pool.query(
      `SELECT provider, model, in_per_m::float8 AS in_per_m, out_per_m::float8 AS out_per_m,
              cached_read_per_m::float8 AS cached_read_per_m, cached_write_per_m::float8 AS cached_write_per_m,
              per_request_usd::float8 AS per_request_usd, effective_from::text AS effective_from, note, updated_at
         FROM llm_prices ORDER BY provider, model, effective_from DESC`);
    return rows;
  }

  /** Models billed as unpriced in the last 30 days (they need a price row). */
  async unpricedModels(): Promise<Array<{ provider: string; model: string; calls: number; lastAt: string }>> {
    const { rows } = await this.pool.query(
      `SELECT provider, model, COUNT(*)::int AS calls, MAX(at) AS last_at FROM llm_usage
        WHERE cost_source = 'unpriced' AND at > now() - interval '30 days' GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 50`);
    return rows.map((x: any) => ({ provider: x.provider, model: x.model, calls: n(x.calls), lastAt: new Date(x.last_at).toISOString() }));
  }

  async upsertPrice(p: {
    provider: string; model: string; inPerM: number; outPerM: number; cachedReadPerM: number | null; cachedWritePerM: number | null;
    perRequestUsd: number | null; effectiveFrom: string; note: string | null;
  }): Promise<{ created: boolean }> {
    const { rows } = await this.pool.query(
      `INSERT INTO llm_prices (provider, model, in_per_m, out_per_m, cached_read_per_m, cached_write_per_m, per_request_usd, effective_from, note, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, now())
       ON CONFLICT (provider, model, effective_from) DO UPDATE SET
         in_per_m = EXCLUDED.in_per_m, out_per_m = EXCLUDED.out_per_m, cached_read_per_m = EXCLUDED.cached_read_per_m,
         cached_write_per_m = EXCLUDED.cached_write_per_m, per_request_usd = EXCLUDED.per_request_usd,
         note = EXCLUDED.note, updated_at = now()
       RETURNING (xmax = 0) AS created`,
      [p.provider, p.model, p.inPerM, p.outPerM, p.cachedReadPerM, p.cachedWritePerM, p.perRequestUsd, p.effectiveFrom, p.note]);
    return { created: !!rows[0]?.created };
  }

  async deletePrice(provider: string, model: string, effectiveFrom: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM llm_prices WHERE provider = $1 AND model = $2 AND effective_from = $3::date`, [provider, model, effectiveFrom]);
    return (rowCount ?? 0) > 0;
  }

  /** `estimate` / `unpriced` rows of the last `days` days after `afterId` (keyset). */
  async repriceCandidates(days: number, afterId: number, limit: number): Promise<RepriceCandidate[]> {
    const { rows } = await this.pool.query(
      `SELECT id, provider, model, kind, at, status, tokens_in, tokens_out, tokens_cached_read, tokens_cached_write,
              cost_usd::float8 AS cost_usd, cost_source
         FROM llm_usage
        WHERE cost_source IN ('estimate', 'unpriced') AND at >= now() - make_interval(days => $1::int) AND id > $2
        ORDER BY id LIMIT $3`, [days, afterId, limit]);
    return rows.map((x: any) => ({
      id: Number(x.id), provider: x.provider, model: x.model, kind: x.kind, at: new Date(x.at), status: x.status,
      tokensIn: nn(x.tokens_in), tokensOut: nn(x.tokens_out), tokensCachedRead: nn(x.tokens_cached_read), tokensCachedWrite: nn(x.tokens_cached_write),
      costUsd: nn(x.cost_usd), costSource: x.cost_source,
    }));
  }

  /** Set new costs; the WHERE keeps provider/backfill rows untouchable even if a caller passes their ids. */
  async applyReprice(updates: Array<{ id: number; costUsd: number | null; costSource: 'estimate' | 'unpriced' }>): Promise<number> {
    if (!updates.length) return 0;
    const { rowCount } = await this.pool.query(
      `UPDATE llm_usage u SET cost_usd = v.cost, cost_source = v.src
         FROM unnest($1::bigint[], $2::numeric[], $3::text[]) AS v(id, cost, src)
        WHERE u.id = v.id AND u.cost_source IN ('estimate', 'unpriced')`,
      [updates.map((u) => u.id), updates.map((u) => u.costUsd), updates.map((u) => u.costSource)]);
    return rowCount ?? 0;
  }

  // ── budgets ─────────────────────────────────────────────────────────────

  async listBudgets(): Promise<any[]> {
    const { rows } = await this.pool.query(
      `SELECT id, scope_kind, scope_key, daily_usd::float8 AS daily_usd, monthly_usd::float8 AS monthly_usd, alert_pct, enforce,
              seeded_from, updated_at
         FROM llm_budgets ORDER BY id`);
    return rows;
  }

  async getBudget(id: number): Promise<any | null> {
    const { rows } = await this.pool.query(`SELECT id, scope_kind, scope_key, seeded_from FROM llm_budgets WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  /** Insert or update by (scope_kind, scope_key); `id` updates that row (its scope may change). */
  async upsertBudget(b: {
    id?: number; scopeKind: string; scopeKey: string; dailyUsd: number | null; monthlyUsd: number | null; alertPct: number; enforce: boolean;
  }): Promise<{ id: number; created: boolean } | null> {
    if (b.id != null) {
      const { rows } = await this.pool.query(
        `UPDATE llm_budgets SET scope_kind = $2, scope_key = $3, daily_usd = $4, monthly_usd = $5, alert_pct = $6, enforce = $7, updated_at = now()
          WHERE id = $1 RETURNING id`, [b.id, b.scopeKind, b.scopeKey, b.dailyUsd, b.monthlyUsd, b.alertPct, b.enforce]);
      return rows[0] ? { id: Number(rows[0].id), created: false } : null;
    }
    const { rows } = await this.pool.query(
      `INSERT INTO llm_budgets (scope_kind, scope_key, daily_usd, monthly_usd, alert_pct, enforce, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (scope_kind, scope_key) DO UPDATE SET daily_usd = EXCLUDED.daily_usd, monthly_usd = EXCLUDED.monthly_usd,
         alert_pct = EXCLUDED.alert_pct, enforce = EXCLUDED.enforce, updated_at = now()
       RETURNING id, (xmax = 0) AS created`, [b.scopeKind, b.scopeKey, b.dailyUsd, b.monthlyUsd, b.alertPct, b.enforce]);
    return { id: Number(rows[0].id), created: !!rows[0].created };
  }

  async deleteBudget(id: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM llm_budgets WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }

  /** ai_logs rows written before the ledger started (they carry no tokens or cost). */
  async callsBeforeLedger(): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::bigint AS n FROM ai_logs
        WHERE created_at < COALESCE((SELECT MIN(at) FROM llm_usage WHERE cost_source <> 'backfill'), now())`);
    return n(rows[0]?.n);
  }
}
