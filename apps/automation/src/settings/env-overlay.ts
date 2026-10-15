/**
 * Spec 039 FR-003 / FR-004: before Nest loads any module, take the `.env` values of the catalog keys into the DB (once per key,
 * secrets encrypted) and put the DB values into `process.env`, so every `ConfigService.get` / `process.env` read sees the
 * dashboard's value. A key imported earlier but without a row (reset on the dashboard) is removed from `process.env`: the
 * code's built-in default applies. The DB unreachable → env stays as it is (logged); a secret that cannot be decrypted (the
 * encryption key changed) keeps its env value and is flagged.
 */
import { decryptToken, encryptToken, isEncrypted } from '../common/crypto/token-crypto';
import { SETTINGS, isSecret, normalizeSetting } from './catalog';

export interface Q {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface BootState {
  bootedAt:      string;
  /** The catalog keys' env values before the overlay (`.env` / the container's env_file). */
  envAtStart:    Record<string, string>;
  /** The value each catalog key had in `process.env` once the overlay ran (absent = the built-in default). */
  bootValues:    Record<string, string | undefined>;
  /** Keys taken in from env on this start. */
  imported:      string[];
  /** Secrets whose stored value could not be decrypted (their env value, if any, stays). */
  decryptFailed: string[];
  /** False when the overlay did not run (no DB, no table): env is what the process uses. */
  applied:       boolean;
  error?:        string;
}

let current: BootState | null = null;

/** The state of this process's start-up overlay (null before it ran, e.g. in tests). */
export function bootState(): BootState | null {
  return current;
}

export function setBootState(s: BootState | null): void {
  current = s;
}

/** The env tables whose rows may name an env variable for their token (spec 028 `token_env`). */
const TOKEN_TABLES = ['my_bots', 'meta_accounts', 'telegraph_accounts'] as const;

const present = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

export async function applySettingsOverlay(
  q: Q,
  env: NodeJS.ProcessEnv,
  o: { secret?: string; log?: (msg: string) => void; now?: () => Date } = {},
): Promise<BootState> {
  const log = o.log ?? (() => undefined);
  const secret = present(o.secret) ? o.secret : undefined;
  const keys = SETTINGS.map((d) => d.key);
  const envAtStart: Record<string, string> = {};
  for (const k of keys) if (present(env[k])) envAtStart[k] = env[k] as string;
  const state: BootState = {
    bootedAt: (o.now ?? (() => new Date()))().toISOString(), envAtStart, bootValues: {}, imported: [], decryptFailed: [], applied: false,
  };

  try {
    await q.query(`CREATE TABLE IF NOT EXISTS app_settings_env_imports (key TEXT PRIMARY KEY, imported_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const all = (await q.query<{ key: string; value: string }>(`SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`, [keys])).rows;
    // An empty row is the old Settings page's "cleared" override (it meant: fall back to env): drop it, env imports instead.
    const empty = all.filter((r) => r.value === '').map((r) => r.key);
    if (empty.length) await q.query(`DELETE FROM app_settings WHERE key = ANY($1::text[]) AND value = ''`, [empty]);
    const rows = new Map(all.filter((r) => r.value !== '').map((r) => [r.key, r.value]));
    const marked = new Set((await q.query<{ key: string }>(
      `SELECT key FROM app_settings_env_imports WHERE key = ANY($1::text[])`, [keys])).rows.map((r) => r.key));

    // Rows that predate the import (the old Settings page, platform cooldowns) count as imported.
    const mark = async (k: string) => {
      await q.query(`INSERT INTO app_settings_env_imports (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`, [k]);
      marked.add(k);
    };
    for (const k of rows.keys()) if (!marked.has(k)) await mark(k);

    for (const d of SETTINGS) {
      if (marked.has(d.key) || rows.has(d.key) || !present(envAtStart[d.key])) continue;
      const norm = normalizeSetting(d, envAtStart[d.key]);
      if ('error' in norm) { log(`settings: ${d.key} in env is not imported (${norm.error}); env keeps applying`); continue; }
      if (isSecret(d) && !secret) { log(`settings: ${d.key} is not imported: TOKEN_ENCRYPTION_KEY is not set`); continue; }
      const stored = isSecret(d) ? encryptToken(norm.value, secret as string) : norm.value;
      await q.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO NOTHING`, [d.key, stored]);
      rows.set(d.key, stored);
      await mark(d.key);
      state.imported.push(d.key);
    }
    if (state.imported.length) log(`settings: imported from env: ${state.imported.join(', ')}`);

    if (secret) await importEnvTokens(q, env, secret, log);

    for (const d of SETTINGS) {
      const stored = rows.get(d.key);
      if (stored !== undefined) {
        if (isSecret(d) && isEncrypted(stored)) {
          if (!secret) { state.decryptFailed.push(d.key); continue; }
          try { env[d.key] = decryptToken(stored, secret); } catch { state.decryptFailed.push(d.key); }
        } else {
          env[d.key] = stored;
        }
      } else if (marked.has(d.key)) {
        delete env[d.key];
      }
    }
    if (state.decryptFailed.length) log(`settings: cannot decrypt ${state.decryptFailed.join(', ')} (TOKEN_ENCRYPTION_KEY changed?); env values kept`);
    state.applied = true;
  } catch (err: any) {
    state.error = String(err?.message ?? err).slice(0, 300);
    log(`settings: overlay skipped, env applies as is: ${state.error}`);
  }

  for (const k of keys) state.bootValues[k] = env[k];
  return state;
}

/** Bot / Meta / Telegraph rows that still read their token from an env variable get it encrypted into `token_enc`. */
async function importEnvTokens(q: Q, env: NodeJS.ProcessEnv, secret: string, log: (msg: string) => void): Promise<void> {
  for (const t of TOKEN_TABLES) {
    try {
      const { rows } = await q.query<{ id: string; token_env: string }>(
        `SELECT id, token_env FROM ${t} WHERE token_enc IS NULL AND token_env IS NOT NULL AND token_env <> ''`);
      let n = 0;
      for (const r of rows) {
        const v = env[r.token_env];
        if (!present(v)) continue;
        await q.query(`UPDATE ${t} SET token_enc = $1 WHERE id = $2 AND token_enc IS NULL`, [encryptToken(v.trim(), secret), r.id]);
        n++;
      }
      if (n) log(`settings: ${n} ${t} token(s) moved from env into the DB (encrypted)`);
    } catch (err: any) {
      log(`settings: ${t} tokens not imported: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }
}
