import type { Pool } from 'pg';

export type LlmProvider = 'openrouter' | 'anthropic' | 'openai' | 'perplexity' | 'xai' | 'agent_sdk' | 'tool';

/** One row of llm_prices: USD per 1M tokens (and an optional per-request fee) from `effectiveFrom` on. */
export interface PriceRow {
  provider:        string;
  model:           string;
  inPerM:          number;
  outPerM:         number;
  cachedReadPerM:  number | null;
  cachedWritePerM: number | null;
  perRequestUsd:   number | null;
  /** YYYY-MM-DD (a Kyiv day). */
  effectiveFrom:   string;
}

export interface PriceSource {
  list(): Promise<PriceRow[]>;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export class LlmPricesRepository implements PriceSource {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async list(): Promise<PriceRow[]> {
    const { rows } = await this.pool.query(
      `SELECT provider, model, in_per_m, out_per_m, cached_read_per_m, cached_write_per_m, per_request_usd,
              effective_from::text AS effective_from
         FROM llm_prices
        ORDER BY provider, model, effective_from`);
    return rows.map((r: any) => ({
      provider: r.provider, model: r.model,
      inPerM: Number(r.in_per_m), outPerM: Number(r.out_per_m),
      cachedReadPerM: num(r.cached_read_per_m), cachedWritePerM: num(r.cached_write_per_m),
      perRequestUsd: num(r.per_request_usd), effectiveFrom: String(r.effective_from),
    }));
  }
}
