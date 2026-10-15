/**
 * Spec 039: runs the settings overlay (env-overlay.ts) before `main.ts` loads `AppModule`, on its own short-lived connection
 * (the Nest pool does not exist yet). Never throws: without a DB the process starts on env as before.
 */
import { Pool } from 'pg';
import { applySettingsOverlay, setBootState, type BootState } from './env-overlay';

export async function bootSettings(log: (msg: string) => void): Promise<BootState> {
  const env = process.env;
  const pool = new Pool({
    host:     env.POSTGRES_HOST ?? 'localhost',
    port:     Number(env.POSTGRES_PORT ?? 5432),
    database: env.POSTGRES_DB ?? 'ai0global',
    user:     env.POSTGRES_USER ?? 'ai0',
    password: env.POSTGRES_PASSWORD ?? 'changeme',
    max: 1, connectionTimeoutMillis: 10_000,
  });
  pool.on('error', () => undefined);
  try {
    const state = await applySettingsOverlay(pool, env, { secret: env.TOKEN_ENCRYPTION_KEY, log });
    setBootState(state);
    return state;
  } finally {
    await pool.end().catch(() => undefined);
  }
}
