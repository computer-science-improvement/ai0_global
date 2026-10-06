/** Test helper: a real LlmUsageService over an in-memory pool, so client tests can read the rows they produce. */
import { LlmUsageService, type BudgetGuard } from './llm-usage.service';

export interface CapturedRow {
  at: Date; provider: string; model: string; kind: string; feature: string; agent_id: string | null; agent_handle: string | null;
  role: string | null; run_id: string | null; step_idx: number | null; resource_ref: string | null;
  tokens_in: number | null; tokens_out: number | null; tokens_cached_read: number | null; tokens_cached_write: number | null;
  cost_usd: number | null; cost_source: string; latency_ms: number | null; attempts: number; status: string; error_code: string | null; shadow: boolean;
}

export function captureUsage(opts: { budget?: BudgetGuard; price?: (model: string, u: any) => number | null } = {}) {
  const rows: CapturedRow[] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      const cols = /AS v\(([^)]+)\)/.exec(sql)![1].split(',').map((c) => c.trim());
      for (let i = 0; i < params.length; i += cols.length) rows.push(Object.fromEntries(cols.map((c, j) => [c, params[i + j]])) as any);
      return { rows: [], rowCount: params.length / cols.length };
    },
  };
  const prices = {
    estimate: async (_p: string, model: string, u: any) => {
      const usd = opts.price ? opts.price(model, u) : null;
      return usd === null ? { costUsd: null, source: 'unpriced' as const } : { costUsd: usd, source: 'estimate' as const };
    },
  };
  const usage = new LlmUsageService({ pool: pool as any, prices, budget: opts.budget, flushMs: 60_000 });
  return {
    usage,
    /** Flush and return every row written so far. */
    rows: async () => { await usage.flush(); return rows; },
  };
}
