/**
 * Spec 039 on a throwaway Postgres: migration 078 (twice), the start-up import + overlay, the store's writes, and bot tokens
 * moved from env into token_enc. The process env is a plain object here (process.env is never touched). Skipped unless
 * EDITOR_PG_TEST_URL is set. Never point this at a real database. The catalog rows, import marks and the test bot are restored.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { SETTINGS } from './catalog';
import { applySettingsOverlay, setBootState } from './env-overlay';
import { SettingsService } from './settings.service';
import { decryptToken, isEncrypted } from '../common/crypto/token-crypto';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const MIGRATION = join(__dirname, '../../../../database/migrations/078_settings_from_env.sql');
const KEYS = SETTINGS.map((d) => d.key);
const SECRET = 'pg-test-encryption-key';
const BOT = 's039_test_bot';
let pool: Pool;
let savedSettings: Array<{ key: string; value: string }> = [];
let savedMarks: string[] = [];

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  const sql = readFileSync(MIGRATION, 'utf8');
  await pool.query(sql);
  await pool.query(sql); // CI re-applies every file: idempotent
  savedSettings = (await pool.query(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [KEYS])).rows;
  savedMarks = (await pool.query(`SELECT key FROM app_settings_env_imports`)).rows.map((r) => r.key);
  await pool.query(`DELETE FROM app_settings WHERE key = ANY($1)`, [KEYS]);
  await pool.query(`DELETE FROM app_settings_env_imports`);
  await pool.query(`DELETE FROM my_bots WHERE bot_id = $1`, [BOT]);
});

after(async () => {
  if (!url) return;
  setBootState(null);
  await pool.query(`DELETE FROM app_settings WHERE key = ANY($1)`, [KEYS]);
  for (const r of savedSettings) await pool.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2)`, [r.key, r.value]);
  await pool.query(`DELETE FROM app_settings_env_imports`);
  for (const k of savedMarks) await pool.query(`INSERT INTO app_settings_env_imports (key) VALUES ($1)`, [k]);
  await pool.query(`DELETE FROM my_bots WHERE bot_id = $1`, [BOT]);
  await pool.end();
});

test('import once, overlay, then dashboard writes win over .env on the next start', { skip }, async () => {
  await pool.query(`INSERT INTO app_settings (key, value) VALUES ('TELEGRAM_OWNER_ID', '')`); // the old page's "cleared" override
  await pool.query(`INSERT INTO my_bots (bot_id, token_env) VALUES ($1, 'S039_BOT_TOKEN')`, [BOT]);

  const env1: NodeJS.ProcessEnv = { POSTING_COOLDOWN_MIN: '25', OPENROUTER_API_KEY: 'sk-or-pg', TELEGRAM_OWNER_ID: '123456789',
    S039_BOT_TOKEN: '42:token', POSTGRES_PASSWORD: 'pw' };
  const s1 = await applySettingsOverlay(pool, env1, { secret: SECRET });
  assert.equal(s1.applied, true);
  assert.deepEqual(s1.imported.sort(), ['OPENROUTER_API_KEY', 'POSTING_COOLDOWN_MIN', 'TELEGRAM_OWNER_ID']);
  const row = async (k: string) => (await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [k])).rows[0]?.value;
  assert.equal(await row('POSTING_COOLDOWN_MIN'), '25');
  assert.equal(await row('TELEGRAM_OWNER_ID'), '123456789', 'the empty override was dropped and env imported instead');
  const enc = await row('OPENROUTER_API_KEY');
  assert.ok(isEncrypted(enc) && decryptToken(enc, SECRET) === 'sk-or-pg');
  assert.equal(await row('POSTGRES_PASSWORD'), undefined);
  const bot = (await pool.query(`SELECT token_enc FROM my_bots WHERE bot_id = $1`, [BOT])).rows[0];
  assert.equal(decryptToken(bot.token_enc, SECRET), '42:token');

  // The dashboard changes one value and resets another.
  setBootState(s1);
  const store = new SettingsService(pool, { get: (k: string) => ({ TOKEN_ENCRYPTION_KEY: SECRET, NODE_ENV: 'production' } as Record<string, string>)[k] } as any);
  store.env = env1;
  await store.setValue('POSTING_COOLDOWN_MIN', '40');
  await store.reset('TELEGRAM_OWNER_ID');
  await store.setValue('OPENROUTER_BASE_URL', 'https://or.example/api/v1');
  const cat = await store.catalog();
  assert.deepEqual(cat.pendingRestart.sort(), ['OPENROUTER_BASE_URL', 'TELEGRAM_OWNER_ID']);

  // Next start: .env still has the old values; the DB wins and the reset key is gone from env.
  const env2: NodeJS.ProcessEnv = { POSTING_COOLDOWN_MIN: '25', OPENROUTER_API_KEY: 'sk-or-pg', TELEGRAM_OWNER_ID: '123456789' };
  const s2 = await applySettingsOverlay(pool, env2, { secret: SECRET });
  assert.deepEqual(s2.imported, []);
  assert.equal(env2.POSTING_COOLDOWN_MIN, '40');
  assert.equal(env2.TELEGRAM_OWNER_ID, undefined);
  assert.equal(env2.OPENROUTER_BASE_URL, 'https://or.example/api/v1');
  assert.equal(env2.OPENROUTER_API_KEY, 'sk-or-pg');
  setBootState(s2);
  store.env = env2;
  const after2 = await store.catalog();
  assert.deepEqual(after2.pendingRestart, []);
  const cooldown = after2.settings.find((x) => x.key === 'POSTING_COOLDOWN_MIN')!;
  assert.equal(cooldown.envValue, '25', 'the page shows the ignored .env value');
});
