/**
 * The model catalog of the Models page (spec 035 FR-002): OpenRouter's public
 * model list (no API key), fetched server-side with a timeout and cached in
 * process for 24 h. Only models that support tool calling are kept (every
 * agent runs on tools). A failed fetch serves the last good list (stale);
 * without one, a fallback list built from llm_prices + the static price map.
 */

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export interface CatalogModel {
  id:                string;
  name:              string;
  contextLength:     number | null;
  /** USD per 1M prompt tokens (null when unknown). */
  inPerM:            number | null;
  /** USD per 1M completion tokens (null when unknown). */
  outPerM:           number | null;
  supportsReasoning: boolean;
}

export interface CatalogSnapshot {
  models:    CatalogModel[];
  /** When the list was fetched from OpenRouter; null for the fallback list. */
  fetchedAt: string | null;
  /** True when the list is older than the TTL (a refresh failed) or is the fallback. */
  stale:     boolean;
  source:    'openrouter' | 'fallback';
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean; status: number; json(): Promise<unknown>;
}>;

export interface ModelCatalogDeps {
  fetch:     FetchLike;
  /** Models known without the network (llm_prices rows + the static price map). */
  fallback:  () => Promise<CatalogModel[]>;
  url?:      string;
  timeoutMs?: number;
  ttlMs?:    number;
  /** After a failed fetch, wait this long before trying again (no hammering on every page load). */
  retryMs?:  number;
  now?:      () => number;
  log?:      (msg: string) => void;
}

const perM = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1_000_000 * 10_000) / 10_000;
};

/** OpenRouter /models JSON → tool-capable catalog entries (malformed entries are skipped). */
export function parseOpenRouterModels(json: unknown): CatalogModel[] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error('unexpected /models payload');
  const out: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const m of data as any[]) {
    if (!m || typeof m.id !== 'string' || !m.id.trim() || m.id.length > 100) continue;
    const params: unknown[] = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    if (!params.includes('tools')) continue;
    const id = m.id.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    const ctx = Number(m.context_length ?? m.top_provider?.context_length);
    out.push({
      id,
      name: typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 120) : id,
      contextLength: Number.isFinite(ctx) && ctx > 0 ? Math.round(ctx) : null,
      inPerM: perM(m.pricing?.prompt),
      outPerM: perM(m.pricing?.completion),
      supportsReasoning: params.includes('reasoning') || params.includes('include_reasoning'),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export class ModelCatalog {
  private good: { models: CatalogModel[]; at: number } | null = null;
  private failedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(private readonly d: ModelCatalogDeps) {}

  private now(): number { return (this.d.now ?? Date.now)(); }
  private ttl(): number { return this.d.ttlMs ?? 24 * 3_600_000; }

  /** Drop the cache (the next list() fetches again). */
  invalidate(): void {
    this.good = null;
    this.failedAt = 0;
  }

  async list(): Promise<CatalogSnapshot> {
    const now = this.now();
    const fresh = this.good && now - this.good.at < this.ttl();
    const backoff = this.failedAt && now - this.failedAt < (this.d.retryMs ?? 5 * 60_000);
    if (!fresh && !backoff) await this.refresh();
    if (this.good) {
      return {
        models: this.good.models, fetchedAt: new Date(this.good.at).toISOString(),
        stale: this.now() - this.good.at >= this.ttl(), source: 'openrouter',
      };
    }
    let models: CatalogModel[] = [];
    try { models = await this.d.fallback(); } catch (err: any) { this.d.log?.(`model catalog fallback failed: ${err?.message ?? err}`); }
    return { models, fetchedAt: null, stale: true, source: 'fallback' };
  }

  async find(id: string): Promise<CatalogModel | null> {
    return (await this.list()).models.find((m) => m.id === id) ?? null;
  }

  private refresh(): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.fetchOnce()
        .then((models) => { this.good = { models, at: this.now() }; this.failedAt = 0; })
        .catch((err: any) => { this.failedAt = this.now(); this.d.log?.(`model catalog fetch failed: ${err?.message ?? err}`); })
        .finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  private async fetchOnce(): Promise<CatalogModel[]> {
    const ctl = new AbortController();
    const ms = this.d.timeoutMs ?? 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The race also covers a fetch that ignores the abort signal.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { ctl.abort(); reject(new Error(`timeout after ${ms} ms`)); }, ms);
    });
    try {
      const body = await Promise.race([
        (async () => {
          const res = await this.d.fetch(this.d.url ?? OPENROUTER_MODELS_URL, { signal: ctl.signal, headers: { accept: 'application/json' } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })(),
        timeout,
      ]);
      const models = parseOpenRouterModels(body);
      if (!models.length) throw new Error('no tool-capable models in the payload');
      return models;
    } finally {
      clearTimeout(timer);
    }
  }
}
