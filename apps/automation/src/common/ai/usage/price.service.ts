import { kyivDay } from './kyiv-day';
import type { PriceRow, PriceSource } from './llm-prices.repository';

/** Aliases resolved after normalisation (short names used by the Agent SDK, dotted OpenRouter-style ids). */
const ALIASES: Record<string, string> = {
  'haiku':             'claude-haiku-4-5',
  'sonnet':            'claude-sonnet-4-6',
  'claude-haiku-4.5':  'claude-haiku-4-5',
  'claude-sonnet-4.5': 'claude-sonnet-4-5',
  'claude-sonnet-4.6': 'claude-sonnet-4-6',
  'anthropic/claude-haiku-4.5':  'claude-haiku-4-5',
  'anthropic/claude-sonnet-4.5': 'claude-sonnet-4-5',
  'anthropic/claude-sonnet-4.6': 'claude-sonnet-4-6',
  'openai/gpt-4o':     'gpt-4o',
};

/**
 * Canonical model id for price lookup: lower case, no date suffix
 * (`claude-haiku-4-5-20251001` → `claude-haiku-4-5`, `gpt-4o-2024-08-06` → `gpt-4o`),
 * no `-latest`, then the alias map.
 */
export function normalizeModel(model: string): string {
  let m = (model ?? '').trim().toLowerCase();
  m = m.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-latest$/, '');
  return ALIASES[m] ?? m;
}

export interface TokenUsage {
  /** ALL prompt tokens, cached ones included. */
  tokensIn?:          number | null;
  tokensOut?:         number | null;
  tokensCachedRead?:  number | null;
  tokensCachedWrite?: number | null;
  /** Billable requests (Perplexity's per-request fee); default 1. */
  requests?:          number;
}

/**
 * USD for one call at a price row. Cached tokens are billed at their own
 * rate (falling back to the input rate when the row has none); the rest of
 * tokens_in at the input rate.
 */
export function costFromPrice(p: PriceRow, u: TokenUsage): number {
  const read  = Math.max(0, u.tokensCachedRead ?? 0);
  const write = Math.max(0, u.tokensCachedWrite ?? 0);
  const plain = Math.max(0, (u.tokensIn ?? 0) - read - write);
  const out   = Math.max(0, u.tokensOut ?? 0);
  const usd = (plain * p.inPerM
    + read  * (p.cachedReadPerM  ?? p.inPerM)
    + write * (p.cachedWritePerM ?? p.inPerM)
    + out   * p.outPerM) / 1_000_000
    + (p.perRequestUsd ?? 0) * (u.requests ?? 1);
  return Math.round(usd * 1e6) / 1e6;
}

export type EstimateResult = { costUsd: number; source: 'estimate' } | { costUsd: null; source: 'unpriced' };

/**
 * Price lookup over llm_prices (FR-005). Rows are cached in memory and
 * reloaded after `ttlMs`; `price()` picks the latest effective_from ≤ the
 * Kyiv day of `at`. A failed reload keeps the previous rows.
 */
export class PriceService {
  private rows: PriceRow[] | null = null;
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly source: PriceSource,
    private readonly opts: { ttlMs?: number; now?: () => number; onError?: (msg: string) => void } = {},
  ) {}

  invalidate(): void {
    this.loadedAt = 0;
  }

  async price(provider: string, model: string, at: Date = new Date()): Promise<PriceRow | null> {
    const rows = await this.load();
    const want = normalizeModel(model);
    const day = kyivDay(at);
    let best: PriceRow | null = null;
    for (const r of rows) {
      if (r.provider !== provider || normalizeModel(r.model) !== want || r.effectiveFrom > day) continue;
      if (!best || r.effectiveFrom > best.effectiveFrom) best = r;
    }
    return best;
  }

  async estimate(provider: string, model: string, usage: TokenUsage, at: Date = new Date()): Promise<EstimateResult> {
    const p = await this.price(provider, model, at);
    return p ? { costUsd: costFromPrice(p, usage), source: 'estimate' } : { costUsd: null, source: 'unpriced' };
  }

  private async load(): Promise<PriceRow[]> {
    const now = (this.opts.now ?? Date.now)();
    if (this.rows && now - this.loadedAt < (this.opts.ttlMs ?? 10 * 60_000)) return this.rows;
    if (!this.loading) {
      this.loading = this.source.list()
        .then((rows) => { this.rows = rows; this.loadedAt = now; })
        .catch((err) => { this.opts.onError?.(`llm_prices load failed: ${err?.message ?? err}`); if (this.rows) this.loadedAt = now; })
        .finally(() => { this.loading = null; });
    }
    await this.loading;
    return this.rows ?? [];
  }
}
