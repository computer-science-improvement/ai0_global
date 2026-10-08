import type { Pool } from 'pg';

/** app_settings key of the owner's global default model (spec 035); absent → DEFAULT_EDITOR_MODEL. Never an env override. */
export const DEFAULT_MODEL_KEY = 'ai.default_model';

/**
 * The owner's global default model, cached in-process (one Nest process) so
 * every run reads it without a query. A save goes through `set()` and updates
 * the cache at once; the TTL only matters for edits made outside this process.
 * A failed read keeps the last value (null → the built-in default).
 */
export class ModelDefaultsStore {
  private value: string | null = null;
  private loadedAt = 0;
  private loaded = false;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly opts: { ttlMs?: number; now?: () => number; onError?: (msg: string) => void } = {},
  ) {}

  private now(): number { return (this.opts.now ?? Date.now)(); }

  invalidate(): void {
    this.loadedAt = 0;
    this.loaded = false;
  }

  /** The saved default, or null when the owner has not chosen one. */
  async get(): Promise<string | null> {
    if (this.loaded && this.now() - this.loadedAt < (this.opts.ttlMs ?? 60_000)) return this.value;
    if (!this.loading) {
      this.loading = this.pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = $1`, [DEFAULT_MODEL_KEY])
        .then(({ rows }) => { this.value = rows[0]?.value?.trim() || null; })
        .catch((err) => { this.opts.onError?.(`${DEFAULT_MODEL_KEY} read failed: ${err?.message ?? err}`); })
        .finally(() => { this.loaded = true; this.loadedAt = this.now(); this.loading = null; });
    }
    await this.loading;
    return this.value;
  }

  /** Save (or clear with null) the default; the cache changes only after the write succeeded. */
  async set(model: string | null): Promise<void> {
    const v = model?.trim() || null;
    if (v) {
      await this.pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [DEFAULT_MODEL_KEY, v]);
    } else {
      await this.pool.query(`DELETE FROM app_settings WHERE key = $1`, [DEFAULT_MODEL_KEY]);
    }
    this.value = v;
    this.loaded = true;
    this.loadedAt = this.now();
  }
}

/** A runner's read of the global default: never throws, null when there is no store. */
export async function readDefaultModel(fn?: () => Promise<string | null>): Promise<string | null> {
  if (!fn) return null;
  try { return await fn(); } catch { return null; }
}
