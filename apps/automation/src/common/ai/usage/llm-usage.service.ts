import type { Pool } from 'pg';
import { currentLlmContext, type LlmContext } from './llm-context';
import { FEATURES } from './features';
import { kyivDay } from './kyiv-day';
import type { LlmProvider } from './llm-prices.repository';
import type { PriceService } from './price.service';

export type UsageStatus = 'ok' | 'error' | 'timeout';
export type CostSource = 'provider' | 'estimate' | 'unpriced' | 'backfill';

/** What a provider client reports about one logical call. */
export interface CallUsage {
  /** ALL prompt tokens, cached ones included. */
  tokensIn?:          number | null;
  tokensOut?:         number | null;
  tokensCachedRead?:  number | null;
  tokensCachedWrite?: number | null;
  /** Provider-reported USD (OpenRouter usage.cost, Agent SDK total_cost_usd). Absent → priced from llm_prices. */
  costUsd?:           number | null;
  /** Default 'provider' when costUsd is given, otherwise priced at flush. */
  costSource?:        CostSource;
  /** Billable requests for a per-request fee (default 1). */
  requests?:          number;
  attempts?:          number;
}

/** One ledger entry. Explicit attribution fields override the ambient LlmContext. */
export interface LlmUsageEntry extends CallUsage, LlmContext {
  provider:   LlmProvider;
  model:      string;
  kind?:      'llm' | 'tool';
  status?:    UsageStatus;
  errorCode?: string | null;
  latencyMs?: number | null;
  at?:        Date;
}

/** A call in flight: started before the request, closed exactly once with ok() or fail(). */
export interface LlmCallTracker {
  ok(usage?: CallUsage): void;
  fail(err: unknown, usage?: CallUsage): void;
}

/** What provider clients depend on (the real service or the no-op default). */
export interface LlmUsageRecorder {
  record(entry: LlmUsageEntry): void;
  start(meta: { provider: LlmProvider; model: string; kind?: 'llm' | 'tool' } & LlmContext): LlmCallTracker;
  /** Throws BudgetExceededError when a blocking cap covers this call (spec 029 FR-008). */
  guard(provider: LlmProvider, explicit?: LlmContext): Promise<void>;
  flush(): Promise<void>;
}

/** Thrown before a call when a blocking budget is exhausted; callers treat it like any failed call. */
export class BudgetExceededError extends Error {
  constructor(readonly scope: string, readonly spentUsd: number, readonly capUsd: number) {
    super(`LLM budget exceeded (${scope}): $${spentUsd.toFixed(4)} >= $${capUsd}`);
    this.name = 'BudgetExceededError';
  }
}

export function isBudgetExceeded(err: unknown): err is BudgetExceededError {
  return err instanceof BudgetExceededError || (err as any)?.name === 'BudgetExceededError';
}

/** status + a short error code for a failed call (axios, Anthropic SDK, fetch, plain errors). */
export function classifyError(err: unknown): { status: UsageStatus; errorCode: string } {
  const e = err as any;
  const http = e?.response?.status ?? (typeof e?.status === 'number' ? e.status : undefined);
  const msg = String(e?.message ?? e ?? '');
  const timeout = e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT' || /timeout|timed out/i.test(String(e?.name ?? '')) || /timed? ?out|timeout/i.test(msg);
  const code = isBudgetExceeded(err) ? 'budget_exceeded'
    : http ? `http_${http}`
    : timeout ? 'timeout'
    : typeof e?.code === 'string' ? e.code
    : String(e?.name ?? 'error');
  return { status: timeout && !http ? 'timeout' : 'error', errorCode: code.slice(0, 64) };
}

export interface BudgetGuard {
  /** Throws BudgetExceededError when a blocking cap covering (feature, provider, resource) is exhausted. */
  assertWithin(feature: string, provider: LlmProvider, resourceRef: string | null): Promise<void>;
}

export interface LlmUsageServiceDeps {
  pool:      Pick<Pool, 'query'>;
  prices:    Pick<PriceService, 'estimate'>;
  /** Persisted alert dedupe (llm_budget_alerts); without it the dedupe is per process. */
  alertKeys?: { claim(key: string): Promise<boolean> };
  /** Admin alert (Telegram). */
  notify?:   (text: string) => Promise<void> | void;
  log?:      (msg: string) => void;
  budget?:   BudgetGuard;
  flushMs?:  number;
  batchSize?: number;
  now?:      () => Date;
}

interface PendingRow {
  at: Date; provider: string; model: string; kind: 'llm' | 'tool'; feature: string;
  agentId: string | null; agentHandle: string | null; role: string | null; runId: string | null; stepIdx: number | null;
  resourceRef: string | null; tokensIn: number | null; tokensOut: number | null; tokensCachedRead: number | null; tokensCachedWrite: number | null;
  requests: number; costUsd: number | null; costSource: CostSource | null; latencyMs: number | null; attempts: number;
  status: UsageStatus; errorCode: string | null; shadow: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: string | null | undefined) => (v && UUID.test(v) ? v : null);
const intOrNull = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
const COLS = ['at', 'provider', 'model', 'kind', 'feature', 'agent_id', 'agent_handle', 'role', 'run_id', 'step_idx', 'resource_ref',
  'tokens_in', 'tokens_out', 'tokens_cached_read', 'tokens_cached_write', 'cost_usd', 'cost_source', 'latency_ms', 'attempts',
  'status', 'error_code', 'shadow'] as const;
const CASTS = ['timestamptz', 'text', 'text', 'text', 'text', 'uuid', 'text', 'text', 'uuid', 'int', 'text',
  'int', 'int', 'int', 'int', 'numeric', 'text', 'int', 'smallint', 'text', 'text', 'boolean'];

/**
 * The only writer of llm_usage (spec 029 FR-002). Rows are buffered and
 * flushed every `flushMs` or at `batchSize` rows. Writes are best-effort: a
 * failed batch is retried once and then dropped with an error log — it never
 * fails the LLM call. Rows without a provider cost are priced from llm_prices
 * at flush time; an unknown model is stored as 'unpriced' and alerts once per
 * model per Kyiv day.
 */
export class LlmUsageService implements LlmUsageRecorder {
  private buffer: PendingRow[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> = Promise.resolve();
  private readonly localKeys = new Set<string>();

  constructor(private readonly d: LlmUsageServiceDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  record(e: LlmUsageEntry): void {
    const ctx = currentLlmContext();
    const pick = <K extends keyof LlmContext>(k: K): LlmContext[K] => (e[k] !== undefined ? e[k] : ctx[k]);
    const costGiven = typeof e.costUsd === 'number' && Number.isFinite(e.costUsd);
    this.buffer.push({
      at: e.at ?? this.now(),
      provider: e.provider, model: (e.model || 'unknown').slice(0, 200), kind: e.kind ?? 'llm',
      feature: pick('feature') || FEATURES.unattributed,
      agentId: uuidOrNull(pick('agentId')), agentHandle: pick('agentHandle') ?? null, role: pick('role') ?? null,
      runId: uuidOrNull(pick('runId')), stepIdx: intOrNull(pick('stepIdx')), resourceRef: pick('resourceRef') ?? null,
      tokensIn: intOrNull(e.tokensIn), tokensOut: intOrNull(e.tokensOut),
      tokensCachedRead: intOrNull(e.tokensCachedRead), tokensCachedWrite: intOrNull(e.tokensCachedWrite),
      requests: e.requests ?? 1,
      costUsd: costGiven ? (e.costUsd as number) : null,
      costSource: costGiven ? (e.costSource ?? 'provider') : (e.costSource ?? null),
      latencyMs: intOrNull(e.latencyMs), attempts: Math.max(1, intOrNull(e.attempts) ?? 1),
      status: e.status ?? 'ok', errorCode: e.errorCode ? e.errorCode.slice(0, 64) : null,
      shadow: pick('shadow') ?? false,
    });
    if (this.buffer.length >= (this.d.batchSize ?? 50)) void this.flush();
    else this.schedule();
  }

  start(meta: { provider: LlmProvider; model: string; kind?: 'llm' | 'tool' } & LlmContext): LlmCallTracker {
    // Snapshot the attribution now: the call may complete in a callback outside the context.
    const ctx = { ...currentLlmContext() };
    const t0 = Date.now();
    let closed = false;
    const close = (status: UsageStatus, errorCode: string | null, usage?: CallUsage) => {
      if (closed) return;
      closed = true;
      const entry: LlmUsageEntry = {
        ...ctx, ...definedOnly(meta), ...(usage ?? {}), provider: meta.provider, model: meta.model, status, errorCode, latencyMs: Date.now() - t0,
      };
      // A failed call without usage costs nothing (spec 029 FR-003); with tokens it is priced as usual.
      if (status !== 'ok' && entry.costUsd == null && entry.tokensIn == null && entry.tokensOut == null) {
        entry.costUsd = 0; entry.costSource = 'estimate';
      }
      this.record(entry);
    };
    return {
      ok:   (usage) => close('ok', null, usage),
      fail: (err, usage) => { const c = classifyError(err); close(c.status, c.errorCode, usage); },
    };
  }

  async guard(provider: LlmProvider, explicit: LlmContext = {}): Promise<void> {
    if (!this.d.budget) return;
    const ctx = { ...currentLlmContext(), ...definedOnly(explicit) };
    await this.d.budget.assertWithin(ctx.feature || FEATURES.unattributed, provider, ctx.resourceRef ?? null);
  }

  /** Write everything buffered so far (also awaited by budget checks so they see the latest spend). */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const rows = this.buffer;
    this.buffer = [];
    const prev = this.inflight;
    const job = (async () => {
      await prev.catch(() => {});
      if (rows.length) await this.write(rows);
    })();
    this.inflight = job;
    await job;
  }

  /** Rows waiting to be written (for tests and shutdown logs). */
  get pending(): number { return this.buffer.length; }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.d.flushMs ?? 2_000);
    this.timer.unref?.();
  }

  private async write(rows: PendingRow[]): Promise<void> {
    try {
      await this.price(rows);
    } catch (err: any) {
      this.d.log?.(`llm_usage pricing failed: ${err?.message ?? err}`);
    }
    const { sql, params } = insertSql(rows);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.d.pool.query(sql, params);
        return;
      } catch (err: any) {
        if (attempt === 1) this.d.log?.(`llm_usage write failed, ${rows.length} rows dropped: ${err?.message ?? err}`);
      }
    }
  }

  private async price(rows: PendingRow[]): Promise<void> {
    for (const r of rows) {
      if (r.costSource !== null) continue;
      if (r.kind === 'tool' || r.provider === 'tool') { r.costUsd = r.costUsd ?? 0; r.costSource = 'provider'; continue; }
      const res = await this.d.prices.estimate(r.provider, r.model, {
        tokensIn: r.tokensIn, tokensOut: r.tokensOut, tokensCachedRead: r.tokensCachedRead, tokensCachedWrite: r.tokensCachedWrite, requests: r.requests,
      }, r.at);
      r.costUsd = res.costUsd;
      r.costSource = res.source;
      if (res.source === 'unpriced') await this.alertUnpriced(r.provider, r.model, r.at);
    }
  }

  private async alertUnpriced(provider: string, model: string, at: Date): Promise<void> {
    const key = `unpriced:${provider}:${model}:${kyivDay(at)}`;
    try {
      const first = this.d.alertKeys ? await this.d.alertKeys.claim(key) : !this.localKeys.has(key);
      this.localKeys.add(key);
      if (first) await this.d.notify?.(`💸 LLM spend: модель ${provider}/${model} без ціни в llm_prices — виклики записано як unpriced. Додайте ціну на сторінці Spend → Prices.`);
    } catch (err: any) {
      this.d.log?.(`unpriced alert failed: ${err?.message ?? err}`);
    }
  }
}

function definedOnly<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as any)[k] = v;
  return out;
}

function insertSql(rows: PendingRow[]): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const tuples = rows.map((r) => {
    const vals = [r.at, r.provider, r.model, r.kind, r.feature, r.agentId, r.agentHandle, r.role, r.runId, r.stepIdx, r.resourceRef,
      r.tokensIn, r.tokensOut, r.tokensCachedRead, r.tokensCachedWrite, r.costUsd, r.costSource, r.latencyMs, r.attempts,
      r.status, r.errorCode, r.shadow];
    const ph = vals.map((v, i) => { params.push(v); return `$${params.length}::${CASTS[i]}`; });
    return `(${ph.join(', ')})`;
  });
  // agent_id / run_id are kept only when the referenced row still exists (FKs never fail the batch);
  // root_agent_id and agent_handle are snapshots taken now.
  const sql =
    `INSERT INTO llm_usage (at, provider, model, kind, feature, agent_id, root_agent_id, agent_handle, role, run_id, step_idx, resource_ref,
       tokens_in, tokens_out, tokens_cached_read, tokens_cached_write, cost_usd, cost_source, latency_ms, attempts, status, error_code, shadow)
     SELECT v.at, v.provider, v.model, v.kind, v.feature, a.id, COALESCE(a.parent_id, a.id), COALESCE(v.agent_handle, a.handle), v.role,
            r.id, v.step_idx, v.resource_ref, v.tokens_in, v.tokens_out, v.tokens_cached_read, v.tokens_cached_write,
            v.cost_usd, v.cost_source, v.latency_ms, v.attempts, v.status, v.error_code, v.shadow
       FROM (VALUES ${tuples.join(',\n')}) AS v(${COLS.join(', ')})
       LEFT JOIN agents a      ON a.id = v.agent_id
       LEFT JOIN editor_runs r ON r.id = v.run_id
     ON CONFLICT DO NOTHING`;
  return { sql, params };
}

// ── process-wide default ────────────────────────────────────────────────────

const NOOP: LlmUsageRecorder = {
  record: () => {},
  start: () => ({ ok: () => {}, fail: () => {} }),
  guard: async () => {},
  flush: async () => {},
};
let current: LlmUsageRecorder = NOOP;

/** Register the app's recorder (done once by LlmUsageModule); clients built with `new` pick it up. */
export function setLlmUsage(r: LlmUsageRecorder | null): void { current = r ?? NOOP; }
/** The registered recorder, or a no-op one (unit tests, scripts). */
export function llmUsage(): LlmUsageRecorder { return current; }
