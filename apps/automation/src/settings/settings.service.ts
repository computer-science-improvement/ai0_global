import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { encryptToken } from '../common/crypto/token-crypto';
import { SETTINGS, SETTING_GROUPS, isSecret, normalizeSetting, settingDef, type SettingDef } from './catalog';
import { bootState } from './env-overlay';

/**
 * The dashboard's settings (spec 039). At start the overlay (env-overlay.ts) has put the DB values of the catalog keys into
 * `process.env`, so the effective value of a key is simply `process.env[key]` ?? the catalog default — the same thing every
 * `ConfigService.get` reader sees. A write here stores the row (secrets encrypted) and updates `process.env` at once: `live`
 * keys apply on their next read, `restart` keys report pending until the process restarts.
 *
 * The old `GET / PATCH /settings` (the Telegram "Tracking" block, spec 015) keep their shape on top of the same store.
 */

export interface SettingsPatch {
  trackingEnabled?:      boolean;
  telegramOwnerId?:      string;
  trackingShareSession?: boolean;
  statsPostAgeDays?:     number;
  postingCooldownMin?:   number;
  fetchTimeoutMs?:       number;
}

/** Maps a patch field → its underlying env key. */
const FIELD_TO_KEY: Record<keyof SettingsPatch, string> = {
  trackingEnabled:      'TRACKING_ENABLED',
  telegramOwnerId:      'TELEGRAM_OWNER_ID',
  trackingShareSession: 'TELEGRAM_TRACKING_SHARE_SESSION',
  statsPostAgeDays:     'STATS_POST_AGE_DAYS',
  postingCooldownMin:   'POSTING_COOLDOWN_MIN',
  fetchTimeoutMs:       'FETCH_TIMEOUT',
};

/** Spec 033: capability flags the services keep in app_settings (`cap.*`, e.g. rich messages unsupported): never env overrides. */
export function isCapabilityKey(key: string): boolean {
  return key.startsWith('cap.');
}

/** UI-state rows in app_settings (spec 027 FR-004): never env overrides. */
export function isUiKey(key: string): boolean {
  return key.startsWith('ui.');
}

/** Public landing settings (spec 026 FR-002, `landing.*`, owned by LandingConfigService): never env overrides. */
export function isLandingKey(key: string): boolean {
  return key.startsWith('landing.');
}

/** AI settings owned by the Models page (spec 035, `ai.*`, e.g. `ai.default_model`): never env overrides. */
export function isAiKey(key: string): boolean {
  return key.startsWith('ai.');
}

export type SettingSource = 'db' | 'env' | 'default';

/** One setting as the Configuration tab shows it. A secret's value is never sent: only whether it is set. */
export interface SettingState {
  key:            string;
  group:          string;
  label:          string;
  help:           string;
  type:           SettingDef['type'];
  apply:          SettingDef['apply'];
  default:        string;
  min?:           number;
  max?:           number;
  options?:       readonly string[];
  bool?:          { on: string; off: string };
  danger?:        boolean;
  /** The effective value (null for secrets, and when unset). */
  value:          string | null;
  set:            boolean;
  source:         SettingSource;
  updatedAt:      string | null;
  /** A `restart` setting whose value differs from the one the process started with. */
  pendingRestart: boolean;
  /** `.env` had a different value at start; it is ignored (the DB wins). Null when not. Secrets: '•' only. */
  envValue:       string | null;
  decryptFailed:  boolean;
}

export interface CatalogState {
  groups:           ReadonlyArray<{ id: string; label: string }>;
  settings:         SettingState[];
  /** TOKEN_ENCRYPTION_KEY is set: secrets can be stored. */
  encryptionReady:  boolean;
  restartSupported: boolean;
  bootedAt:         string | null;
  overlayApplied:   boolean;
  overlayError:     string | null;
  pendingRestart:   string[];
}

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  /** The environment the process reads (tests swap it). */
  env: NodeJS.ProcessEnv = process.env;
  /** Stops the process for a restart (tests swap it). */
  exit: () => void = () => {
    // enableShutdownHooks (main.ts) closes the app and exits on SIGTERM; Docker (restart: unless-stopped) starts it again.
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 300);
    setTimeout(() => process.exit(0), 15_000).unref();
  };

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly config: ConfigService,
  ) {}

  /** Kept for the boot-time readers (MTProto connect): the values are in process.env before Nest starts. */
  whenLoaded(): Promise<void> {
    return Promise.resolve();
  }

  /** Effective raw string for a key: process.env (DB overlay or env) ?? the catalog default. */
  private raw(key: string): string {
    const v = this.env[key];
    return v !== undefined ? v : settingDef(key)?.default ?? '';
  }

  // ── Typed getters (consumers read these, never process.env directly) ──────
  trackingEnabled():      boolean { return this.raw('TRACKING_ENABLED') === 'true'; }
  trackingShareSession(): boolean { return this.raw('TELEGRAM_TRACKING_SHARE_SESSION') === 'true'; }
  /** Owner chat id for admin notifications (TELEGRAM_OWNER_ID); '' when unset. */
  telegramOwnerId():      string  { return this.raw('TELEGRAM_OWNER_ID'); }
  statsPostAgeDays():     number  { return this.intRaw('STATS_POST_AGE_DAYS', 30); }
  postingCooldownMin():   number  { return Math.max(1, this.intRaw('POSTING_COOLDOWN_MIN', 20)); }
  fetchTimeoutMs():       number  { return this.intRaw('FETCH_TIMEOUT', 15000); }

  /** Cooldown (minutes) for a Meta platform; configurable like the Telegram one. */
  metaCooldownMin(platform: 'instagram' | 'facebook' | 'threads'): number {
    const key = `${platform.toUpperCase()}_COOLDOWN_MIN`;
    const def = platform === 'instagram' ? 30 : platform === 'facebook' ? 15 : 10;
    return Math.max(1, this.intRaw(key, def));
  }

  private intRaw(key: string, fallback: number): number {
    const n = parseInt(this.raw(key), 10);
    return Number.isFinite(n) ? n : fallback;
  }

  private async rows(): Promise<Map<string, { value: string; updatedAt: string | null }>> {
    const { rows } = await this.pool.query<{ key: string; value: string; updated_at: Date | string | null }>(
      `SELECT key, value, updated_at FROM app_settings WHERE key = ANY($1::text[])`, [SETTINGS.map((d) => d.key)]);
    return new Map(rows.filter((r) => settingDef(r.key)).map((r) => [r.key, { value: r.value, updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null }]));
  }

  private stateOf(d: SettingDef, row: { value: string; updatedAt: string | null } | undefined): SettingState {
    const boot = bootState();
    const cur = this.env[d.key];
    const set = cur !== undefined && cur !== '';
    const atStart = boot?.envAtStart[d.key];
    const decryptFailed = !!boot?.decryptFailed.includes(d.key);
    // `.env` differs: it had a value at start, the DB holds another one now (an unreadable secret: its env value applies).
    const norm = atStart === undefined ? undefined : normalizeSetting(d, atStart);
    const atStartNorm = norm === undefined ? undefined : 'value' in norm ? norm.value : (atStart as string).trim();
    const differs = !!row && atStartNorm !== undefined && !decryptFailed && atStartNorm !== (cur ?? '');
    return {
      key: d.key, group: d.group, label: d.label, help: d.help, type: d.type, apply: d.apply, default: d.default,
      ...(d.min !== undefined ? { min: d.min } : {}), ...(d.max !== undefined ? { max: d.max } : {}),
      ...(d.options ? { options: d.options } : {}), ...(d.bool ? { bool: d.bool } : {}), ...(d.danger ? { danger: true } : {}),
      value: isSecret(d) || !set ? null : (cur as string),
      set,
      source: row && !decryptFailed ? 'db' : set ? 'env' : 'default',
      updatedAt: row?.updatedAt ?? null,
      pendingRestart: d.apply === 'restart' && !!boot && (boot.bootValues[d.key] ?? '') !== (cur ?? ''),
      envValue: differs ? (isSecret(d) ? '•' : (atStart as string)) : null,
      decryptFailed,
    };
  }

  /** GET /settings/catalog (FR-006). */
  async catalog(): Promise<CatalogState> {
    const rows = await this.rows();
    const settings = SETTINGS.map((d) => this.stateOf(d, rows.get(d.key)));
    const boot = bootState();
    return {
      groups: SETTING_GROUPS, settings,
      encryptionReady: !!this.config.get<string>('TOKEN_ENCRYPTION_KEY'),
      restartSupported: this.restartSupported(),
      bootedAt: boot?.bootedAt ?? null,
      overlayApplied: !!boot?.applied,
      overlayError: boot?.error ?? null,
      pendingRestart: settings.filter((s) => s.pendingRestart).map((s) => s.key),
    };
  }

  private def(key: string): SettingDef {
    const d = settingDef(key);
    if (!d) throw new NotFoundException({ error: 'unknown_setting', message: `${key} is not a dashboard setting` });
    return d;
  }

  private async markImported(key: string): Promise<void> {
    await this.pool.query(`INSERT INTO app_settings_env_imports (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`, [key]);
  }

  private async one(d: SettingDef): Promise<SettingState> {
    return this.stateOf(d, (await this.rows()).get(d.key));
  }

  /** PUT /settings/values/:key (FR-005): validate, store (secrets encrypted), apply to process.env at once. */
  async setValue(key: string, raw: unknown): Promise<SettingState> {
    const d = this.def(key);
    const norm = normalizeSetting(d, raw);
    if ('error' in norm) throw new BadRequestException({ error: 'invalid_value', message: `${d.label}: ${norm.error}` });
    let stored = norm.value;
    if (isSecret(d)) {
      const secret = this.config.get<string>('TOKEN_ENCRYPTION_KEY');
      if (!secret) throw new ConflictException({ error: 'encryption_unavailable', message: 'TOKEN_ENCRYPTION_KEY is not set on the server: secrets cannot be stored' });
      stored = encryptToken(norm.value, secret);
    }
    await this.pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [d.key, stored]);
    await this.markImported(d.key);
    this.env[d.key] = norm.value;
    this.logger.log(`setting changed: ${d.key}${d.apply === 'restart' ? ' (applies after a restart)' : ''}`);
    return this.one(d);
  }

  /** DELETE /settings/values/:key: back to the built-in default (`.env` stays ignored; use importEnv for it). */
  async reset(key: string): Promise<SettingState> {
    const d = this.def(key);
    await this.pool.query(`DELETE FROM app_settings WHERE key = $1`, [d.key]);
    await this.markImported(d.key);
    delete this.env[d.key];
    this.logger.log(`setting reset to default: ${d.key}`);
    return this.one(d);
  }

  /** POST /settings/values/:key/import-env: take the value `.env` had when the process started. */
  async importEnv(key: string): Promise<SettingState> {
    const d = this.def(key);
    const v = bootState()?.envAtStart[d.key];
    if (v === undefined) throw new NotFoundException({ error: 'no_env_value', message: `${d.key} had no value in .env at start` });
    return this.setValue(d.key, v);
  }

  restartSupported(): boolean {
    // Under `nest start` on a laptop nothing would start the process again.
    return (this.config.get<string>('NODE_ENV') ?? '') !== 'local-development';
  }

  /** POST /settings/restart (FR-007). */
  restart(): { restarting: true } {
    if (!this.restartSupported()) {
      throw new ConflictException({ error: 'restart_unsupported', message: 'Restart works only under Docker; restart the local process by hand' });
    }
    this.logger.warn('restart requested from the Settings page');
    this.exit();
    return { restarting: true };
  }

  /** Snapshot for the old Settings block. AI-key fields are booleans only — the key values are NEVER returned.
   *  `overrides` lists which keys are pinned in the DB. */
  async get() {
    const rows = await this.rows();
    return {
      telegram: {
        trackingEnabled:      this.trackingEnabled(),
        ownerId:              this.telegramOwnerId(),
        trackingShareSession: this.trackingShareSession(),
        statsPostAgeDays:     this.statsPostAgeDays(),
        postingCooldownMin:   this.postingCooldownMin(),
        fetchTimeoutMs:       this.fetchTimeoutMs(),
      },
      ai: {
        anthropic:  !!this.env.ANTHROPIC_API_KEY,
        perplexity: !!this.env.PERPLEXITY_API_KEY,
        openai:     !!this.env.OPENAI_API_KEY,
        grok:       !!this.env.GROK_API_KEY,
      },
      overrides: [...rows.keys()],
    };
  }

  /** The old PATCH: each field goes through setValue; an empty owner id resets it. */
  async update(patch: SettingsPatch): Promise<Awaited<ReturnType<SettingsService['get']>>> {
    for (const [field, value] of Object.entries(patch) as Array<[keyof SettingsPatch, unknown]>) {
      if (value === undefined) continue;
      const key = FIELD_TO_KEY[field];
      if (value === '') await this.reset(key);
      else await this.setValue(key, value);
    }
    return this.get();
  }
}
