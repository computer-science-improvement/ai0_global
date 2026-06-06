import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

/**
 * Source of truth for a small set of env-class settings (the Telegram
 * "Відстеження" block). The effective value is resolved as:
 *
 *     app_settings row (DB override)  ??  process.env  ??  built-in default
 *
 * Overrides are cached in-memory (single Nest process) and loaded once at
 * boot. Because this is a `@Global` singleton, every consumer that injects it
 * shares the same cache — so an `update()` from the dashboard takes effect
 * live for any consumer that re-reads on each tick (tracking on/off, cooldown,
 * stats age). `trackingShareSession` / `fetchTimeout` are read once (MTProto
 * connect / the separate pipeline process), so those apply after a restart.
 */

/** Editable keys + their built-in fallbacks (used when neither DB nor env set). */
const DEFAULTS: Record<string, string> = {
  TRACKING_ENABLED:                'false',
  TELEGRAM_TRACKING_SHARE_SESSION: 'false',
  STATS_POST_AGE_DAYS:             '30',
  POSTING_COOLDOWN_MIN:            '20',
  FETCH_TIMEOUT:                   '15000',
};

export interface SettingsPatch {
  trackingEnabled?:      boolean;
  trackingShareSession?: boolean;
  statsPostAgeDays?:     number;
  postingCooldownMin?:   number;
  fetchTimeoutMs?:       number;
}

/** Maps a patch field → its underlying env key + string serialisation. */
const FIELD_TO_KEY: Record<keyof SettingsPatch, string> = {
  trackingEnabled:      'TRACKING_ENABLED',
  trackingShareSession: 'TELEGRAM_TRACKING_SHARE_SESSION',
  statsPostAgeDays:     'STATS_POST_AGE_DAYS',
  postingCooldownMin:   'POSTING_COOLDOWN_MIN',
  fetchTimeoutMs:       'FETCH_TIMEOUT',
};

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private overrides: Record<string, string> = {};
  /** Resolves once the DB overrides have been read. Boot-time consumers
   *  (MTProto connect) await this so a DB override wins over env after restart. */
  private readonly loaded: Promise<void>;

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly config: ConfigService,
  ) {
    this.loaded = this.load();
  }

  private async load(): Promise<void> {
    try {
      const { rows } = await this.pool.query<{ key: string; value: string }>(
        'SELECT key, value FROM app_settings',
      );
      this.overrides = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    } catch (err: any) {
      // Table may not exist yet (pre-migration); fall back to env silently.
      this.logger.debug(`app_settings load skipped: ${err?.message ?? err}`);
    }
  }

  /** Await before reading settings at boot time (before `load()` resolves). */
  whenLoaded(): Promise<void> {
    return this.loaded;
  }

  /** Effective raw string for a key: DB override ?? env ?? default. */
  private raw(key: string): string {
    return this.overrides[key] ?? this.config.get<string>(key) ?? DEFAULTS[key] ?? '';
  }

  // ── Typed getters (consumers read these, never process.env directly) ──────
  trackingEnabled():      boolean { return this.raw('TRACKING_ENABLED') === 'true'; }
  trackingShareSession(): boolean { return this.raw('TELEGRAM_TRACKING_SHARE_SESSION') === 'true'; }
  statsPostAgeDays():     number  { return this.intRaw('STATS_POST_AGE_DAYS', 30); }
  postingCooldownMin():   number  { return Math.max(1, this.intRaw('POSTING_COOLDOWN_MIN', 20)); }
  fetchTimeoutMs():       number  { return this.intRaw('FETCH_TIMEOUT', 15000); }

  private intRaw(key: string, fallback: number): number {
    const n = parseInt(this.raw(key), 10);
    return Number.isFinite(n) ? n : fallback;
  }

  /** Snapshot for the Settings page. AI-key fields are booleans only — the key
   *  values are NEVER returned. `overrides` lists which keys are DB-pinned. */
  get() {
    return {
      telegram: {
        trackingEnabled:      this.trackingEnabled(),
        trackingShareSession: this.trackingShareSession(),
        statsPostAgeDays:     this.statsPostAgeDays(),
        postingCooldownMin:   this.postingCooldownMin(),
        fetchTimeoutMs:       this.fetchTimeoutMs(),
      },
      ai: {
        anthropic:  !!this.config.get('ANTHROPIC_API_KEY'),
        perplexity: !!this.config.get('PERPLEXITY_API_KEY'),
        openai:     !!this.config.get('OPENAI_API_KEY'),
        grok:       !!this.config.get('GROK_API_KEY'),
      },
      // Keys whose value comes from a DB override (not just env), so the UI can
      // mark them as "overridden".
      overrides: Object.keys(this.overrides),
    };
  }

  /** Persist a patch to app_settings, refresh the cache, and return get(). */
  async update(patch: SettingsPatch): Promise<ReturnType<SettingsService['get']>> {
    const entries: Array<[string, string]> = [];
    for (const [field, value] of Object.entries(patch) as Array<[keyof SettingsPatch, unknown]>) {
      if (value === undefined) continue;
      const key = FIELD_TO_KEY[field];
      const str = typeof value === 'boolean' ? String(value) : String(value);
      entries.push([key, str]);
    }
    if (entries.length === 0) return this.get();

    for (const [key, value] of entries) {
      await this.pool.query(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, value],
      );
      this.overrides[key] = value;
    }
    this.logger.log(`settings updated: ${entries.map(([k]) => k).join(', ')}`);
    return this.get();
  }
}
