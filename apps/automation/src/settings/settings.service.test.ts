/** Spec 039: the settings store on top of process.env (FR-005 – FR-007), and the old GET / PATCH /settings on it. */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsService } from './settings.service';
import { setBootState } from './env-overlay';
import { decryptToken, isEncrypted } from '../common/crypto/token-crypto';

const KEY = 'test-encryption-key';

/** Fake pg: app_settings rows and the import marks. */
function fakePool(seed: Record<string, string> = {}) {
  const rows = new Map(Object.entries(seed));
  const marked = new Set<string>();
  const pool = {
    query: async (sql: string, p: any[] = []) => {
      if (/^SELECT key, value, updated_at FROM app_settings/.test(sql)) {
        return { rows: [...rows].filter(([k]) => p[0].includes(k)).map(([key, value]) => ({ key, value, updated_at: '2026-10-15T10:00:00Z' })) };
      }
      if (/^INSERT INTO app_settings /.test(sql)) { rows.set(p[0], p[1]); return { rows: [] }; }
      if (/^INSERT INTO app_settings_env_imports/.test(sql)) { marked.add(p[0]); return { rows: [] }; }
      if (/^DELETE FROM app_settings/.test(sql)) { rows.delete(p[0]); return { rows: [] }; }
      throw new Error(`unexpected ${sql}`);
    },
  };
  return { pool, rows, marked };
}

function make(env: NodeJS.ProcessEnv = {}, seed: Record<string, string> = {}, cfg: Record<string, string> = { TOKEN_ENCRYPTION_KEY: KEY, NODE_ENV: 'production' }) {
  const db = fakePool(seed);
  const s = new SettingsService(db.pool as any, { get: (k: string) => cfg[k] } as any);
  s.env = env;
  let exited = 0;
  s.exit = () => { exited++; };
  return { s, db, env, exits: () => exited };
}

afterEach(() => setBootState(null));

test('typed getters read process.env (the overlay put the DB value there) and fall back to the catalog default', () => {
  const { s } = make({ TELEGRAM_OWNER_ID: '111', POSTING_COOLDOWN_MIN: '25' });
  assert.equal(s.telegramOwnerId(), '111');
  assert.equal(s.postingCooldownMin(), 25);
  assert.equal(s.statsPostAgeDays(), 30);
  assert.equal(s.metaCooldownMin('instagram'), 30);
  assert.equal(make().s.telegramOwnerId(), '');
});

test('setValue: validated, stored, marked imported and live in process.env', async () => {
  const { s, db, env } = make();
  const st = await s.setValue('POSTING_COOLDOWN_MIN', 45);
  assert.equal(db.rows.get('POSTING_COOLDOWN_MIN'), '45');
  assert.ok(db.marked.has('POSTING_COOLDOWN_MIN'));
  assert.equal(env.POSTING_COOLDOWN_MIN, '45');
  assert.equal(s.postingCooldownMin(), 45);
  assert.equal(st.source, 'db');
  assert.equal(st.value, '45');
  await assert.rejects(s.setValue('POSTING_COOLDOWN_MIN', 0), (e: any) => e.status === 400 && e.response.error === 'invalid_value');
  await assert.rejects(s.setValue('POSTGRES_PASSWORD', 'x'), (e: any) => e.status === 404 && e.response.error === 'unknown_setting');
});

test('secrets: stored encrypted, never returned; without TOKEN_ENCRYPTION_KEY they cannot be set', async () => {
  const { s, db, env } = make();
  const st = await s.setValue('OPENROUTER_API_KEY', 'sk-or-secret');
  const stored = db.rows.get('OPENROUTER_API_KEY')!;
  assert.ok(isEncrypted(stored) && decryptToken(stored, KEY) === 'sk-or-secret');
  assert.equal(env.OPENROUTER_API_KEY, 'sk-or-secret');
  assert.equal(st.value, null);
  assert.equal(st.set, true);
  const cat = await s.catalog();
  assert.ok(!JSON.stringify(cat).includes('sk-or-secret'), 'the catalog never carries a secret');
  const bare = make({}, {}, { NODE_ENV: 'production' });
  await assert.rejects(bare.s.setValue('OPENROUTER_API_KEY', 'sk'), (e: any) => e.status === 409 && e.response.error === 'encryption_unavailable');
});

test('reset: the row goes, process.env loses the key, the default applies (the .env value stays ignored)', async () => {
  const { s, db, env } = make({ POSTING_COOLDOWN_MIN: '45' }, { POSTING_COOLDOWN_MIN: '45' });
  const st = await s.reset('POSTING_COOLDOWN_MIN');
  assert.ok(!db.rows.has('POSTING_COOLDOWN_MIN'));
  assert.ok(db.marked.has('POSTING_COOLDOWN_MIN'));
  assert.equal(env.POSTING_COOLDOWN_MIN, undefined);
  assert.equal(s.postingCooldownMin(), 20);
  assert.equal(st.source, 'default');
});

test('catalog state: source, pending restart, .env differs, and import-env takes the start value', async () => {
  const env: NodeJS.ProcessEnv = { OPENROUTER_BASE_URL: 'https://a.example/v1', AGENT_CHAT_MAX: '30', DASHBOARD_URL: 'https://dash.example' };
  setBootState({
    bootedAt: '2026-10-15T09:00:00.000Z', applied: true, imported: [], decryptFailed: [],
    envAtStart: { AGENT_CHAT_MAX: '50', DASHBOARD_URL: 'https://dash.example' },
    bootValues: { OPENROUTER_BASE_URL: 'https://a.example/v1', AGENT_CHAT_MAX: '30', DASHBOARD_URL: 'https://dash.example' },
  });
  const { s } = make(env, { AGENT_CHAT_MAX: '30', OPENROUTER_BASE_URL: 'https://a.example/v1' });
  await s.setValue('OPENROUTER_BASE_URL', 'https://b.example/v1');
  const cat = await s.catalog();
  const by = (k: string) => cat.settings.find((x) => x.key === k)!;
  assert.deepEqual(cat.pendingRestart, ['OPENROUTER_BASE_URL']);
  assert.equal(by('OPENROUTER_BASE_URL').pendingRestart, true);
  assert.equal(by('AGENT_CHAT_MAX').pendingRestart, false, 'a live setting never waits for a restart');
  assert.equal(by('AGENT_CHAT_MAX').envValue, '50', '.env had another value; it is ignored');
  assert.equal(by('AGENT_CHAT_MAX').source, 'db');
  assert.equal(by('DASHBOARD_URL').source, 'env');
  assert.equal(by('DASHBOARD_URL').envValue, null);
  assert.equal(by('AGENT_REPLY_DAILY_CAP').source, 'default');
  assert.equal(cat.bootedAt, '2026-10-15T09:00:00.000Z');
  assert.equal(cat.encryptionReady, true);
  const back = await s.importEnv('AGENT_CHAT_MAX');
  assert.equal(back.value, '50');
  assert.equal(back.envValue, null);
  await assert.rejects(s.importEnv('AGENT_REPLY_DAILY_CAP'), (e: any) => e.status === 404 && e.response.error === 'no_env_value');
});

test('restart: refused under local-development, scheduled otherwise', () => {
  const prod = make();
  assert.deepEqual(prod.s.restart(), { restarting: true });
  assert.equal(prod.exits(), 1);
  const local = make({}, {}, { NODE_ENV: 'local-development' });
  assert.throws(() => local.s.restart(), (e: any) => e.status === 409 && e.response.error === 'restart_unsupported');
  assert.equal(local.exits(), 0);
});

test('old PATCH: fields go through the store; an empty owner id resets it (no empty override)', async () => {
  const { s, db, env } = make({ TELEGRAM_OWNER_ID: '111' }, { TELEGRAM_OWNER_ID: '111' });
  const fresh = await s.update({ telegramOwnerId: '424242', trackingEnabled: true });
  assert.equal(db.rows.get('TELEGRAM_OWNER_ID'), '424242');
  assert.equal(env.TRACKING_ENABLED, 'true');
  assert.equal(fresh.telegram.ownerId, '424242');
  assert.deepEqual(fresh.overrides.sort(), ['TELEGRAM_OWNER_ID', 'TRACKING_ENABLED']);
  await s.update({ telegramOwnerId: '' });
  assert.ok(!db.rows.has('TELEGRAM_OWNER_ID'));
  assert.equal(s.telegramOwnerId(), '');
});
