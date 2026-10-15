/** Spec 039 FR-003 / FR-004: import from env once, overlay the DB values onto process.env. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySettingsOverlay, type Q } from './env-overlay';
import { decryptToken, encryptToken, isEncrypted } from '../common/crypto/token-crypto';

const KEY = 'test-encryption-key';

/** An in-memory app_settings / app_settings_env_imports / my_bots for the overlay's queries. */
function fakeDb(init: { settings?: Record<string, string>; imported?: string[]; bots?: Array<{ id: string; token_env: string | null; token_enc: string | null }> } = {}) {
  const settings = new Map(Object.entries(init.settings ?? {}));
  const imported = new Set(init.imported ?? []);
  const bots = init.bots ?? [];
  const sql: string[] = [];
  const q: Q = {
    async query(text: string, params: unknown[] = []) {
      sql.push(text);
      const keys = (params[0] ?? []) as string[];
      if (/^CREATE TABLE/.test(text)) return { rows: [] };
      if (/^SELECT key, value FROM app_settings/.test(text)) return { rows: [...settings].filter(([k]) => keys.includes(k)).map(([key, value]) => ({ key, value })) as any };
      if (/^DELETE FROM app_settings/.test(text)) { for (const k of keys) if (settings.get(k) === '') settings.delete(k); return { rows: [] }; }
      if (/^SELECT key FROM app_settings_env_imports/.test(text)) return { rows: [...imported].filter((k) => keys.includes(k)).map((key) => ({ key })) as any };
      if (/^INSERT INTO app_settings_env_imports/.test(text)) { imported.add(params[0] as string); return { rows: [] }; }
      if (/^INSERT INTO app_settings /.test(text)) { if (!settings.has(params[0] as string)) settings.set(params[0] as string, params[1] as string); return { rows: [] }; }
      if (/^SELECT id, token_env FROM my_bots/.test(text)) return { rows: bots.filter((b) => !b.token_enc && b.token_env) as any };
      if (/^UPDATE my_bots/.test(text)) { const b = bots.find((x) => x.id === params[1]); if (b && !b.token_enc) b.token_enc = params[0] as string; return { rows: [] }; }
      if (/FROM (meta_accounts|telegraph_accounts)/.test(text)) throw new Error('relation does not exist');
      throw new Error(`unexpected query: ${text}`);
    },
  };
  return { q, settings, imported, bots, sql };
}

test('first start: env values of catalog keys go into the DB once (secrets encrypted), infra keys never', async () => {
  const db = fakeDb();
  const env: NodeJS.ProcessEnv = { POSTING_COOLDOWN_MIN: '25', OPENROUTER_API_KEY: 'sk-or-1', POSTGRES_PASSWORD: 'pw', EDITOR_ENABLED: 'true', AGENT_CHAT_MAX: '' };
  const s = await applySettingsOverlay(db.q, env, { secret: KEY });
  assert.equal(s.applied, true);
  assert.deepEqual(s.imported.sort(), ['EDITOR_ENABLED', 'OPENROUTER_API_KEY', 'POSTING_COOLDOWN_MIN']);
  assert.equal(db.settings.get('POSTING_COOLDOWN_MIN'), '25');
  const enc = db.settings.get('OPENROUTER_API_KEY')!;
  assert.ok(isEncrypted(enc) && decryptToken(enc, KEY) === 'sk-or-1', 'the secret is stored encrypted');
  assert.ok(!db.settings.has('POSTGRES_PASSWORD'));
  assert.ok(!db.imported.has('AGENT_CHAT_MAX'), 'an empty env value is not imported (a later one still can be)');
  assert.equal(env.OPENROUTER_API_KEY, 'sk-or-1', 'the decrypted value is what the process reads');
  assert.equal(s.envAtStart.POSTING_COOLDOWN_MIN, '25');
});

test('later starts: the DB wins over an edited .env, and a reset key falls back to the built-in default', async () => {
  const db = fakeDb({ settings: { POSTING_COOLDOWN_MIN: '40' }, imported: ['POSTING_COOLDOWN_MIN', 'AGENT_CHAT_MAX'] });
  const env: NodeJS.ProcessEnv = { POSTING_COOLDOWN_MIN: '25', AGENT_CHAT_MAX: '50' };
  const s = await applySettingsOverlay(db.q, env, { secret: KEY });
  assert.equal(env.POSTING_COOLDOWN_MIN, '40');
  assert.equal(env.AGENT_CHAT_MAX, undefined, 'reset on the dashboard → removed, the code default applies');
  assert.deepEqual(s.imported, []);
  assert.equal(s.envAtStart.POSTING_COOLDOWN_MIN, '25', 'the ignored .env value is kept to show it on the page');
  assert.equal(s.bootValues.POSTING_COOLDOWN_MIN, '40');
});

test('rows that predate the import count as imported; an empty old override is dropped and env imports instead', async () => {
  const db = fakeDb({ settings: { TRACKING_ENABLED: 'true', TELEGRAM_OWNER_ID: '' } });
  const env: NodeJS.ProcessEnv = { TRACKING_ENABLED: 'false', TELEGRAM_OWNER_ID: '123456789' };
  await applySettingsOverlay(db.q, env, { secret: KEY });
  assert.ok(db.imported.has('TRACKING_ENABLED'));
  assert.equal(env.TRACKING_ENABLED, 'true');
  assert.equal(db.settings.get('TELEGRAM_OWNER_ID'), '123456789');
  assert.equal(env.TELEGRAM_OWNER_ID, '123456789');
});

test('no encryption key: secrets are not imported and stay in env; invalid env values are not imported', async () => {
  const db = fakeDb();
  const env: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: 'sk-or-1', POSTING_COOLDOWN_MIN: 'soon' };
  const logs: string[] = [];
  await applySettingsOverlay(db.q, env, { log: (m) => logs.push(m) });
  assert.ok(!db.settings.has('OPENROUTER_API_KEY') && !db.imported.has('OPENROUTER_API_KEY'));
  assert.ok(!db.settings.has('POSTING_COOLDOWN_MIN'));
  assert.equal(env.OPENROUTER_API_KEY, 'sk-or-1');
  assert.equal(env.POSTING_COOLDOWN_MIN, 'soon', 'env keeps applying as before');
  assert.ok(logs.some((l) => /TOKEN_ENCRYPTION_KEY is not set/.test(l)));
});

test('a secret that cannot be decrypted keeps its env value and is flagged', async () => {
  const db = fakeDb({ settings: { OPENROUTER_API_KEY: encryptToken('sk-old', 'another-key') }, imported: ['OPENROUTER_API_KEY'] });
  const env: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: 'sk-env' };
  const s = await applySettingsOverlay(db.q, env, { secret: KEY });
  assert.deepEqual(s.decryptFailed, ['OPENROUTER_API_KEY']);
  assert.equal(env.OPENROUTER_API_KEY, 'sk-env');
});

test('bot tokens named by token_env are encrypted into token_enc; a missing table is skipped', async () => {
  const db = fakeDb({ bots: [
    { id: 'b1', token_env: 'TELEGRAM_BOT2_TOKEN', token_enc: null },
    { id: 'b2', token_env: 'NOT_SET_TOKEN', token_enc: null },
    { id: 'b3', token_env: 'TELEGRAM_BOT2_TOKEN', token_enc: 'enc:v1:already' },
  ] });
  const logs: string[] = [];
  await applySettingsOverlay(db.q, { TELEGRAM_BOT2_TOKEN: '123:abc' }, { secret: KEY, log: (m) => logs.push(m) });
  assert.equal(decryptToken(db.bots[0].token_enc!, KEY), '123:abc');
  assert.equal(db.bots[1].token_enc, null);
  assert.equal(db.bots[2].token_enc, 'enc:v1:already');
  assert.ok(logs.some((l) => /meta_accounts tokens not imported/.test(l)));
});

test('the DB unreachable: env is left as it is', async () => {
  const env: NodeJS.ProcessEnv = { POSTING_COOLDOWN_MIN: '25' };
  const s = await applySettingsOverlay({ query: async () => { throw new Error('ECONNREFUSED'); } }, env, { secret: KEY });
  assert.equal(s.applied, false);
  assert.match(s.error!, /ECONNREFUSED/);
  assert.equal(env.POSTING_COOLDOWN_MIN, '25');
  assert.equal(s.bootValues.POSTING_COOLDOWN_MIN, '25');
});
