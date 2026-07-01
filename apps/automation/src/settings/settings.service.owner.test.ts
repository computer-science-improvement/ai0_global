import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsService } from './settings.service';

/** Fake pg pool: load() reads `seed` rows; update() records writes. */
function fakePool(seed: Array<{ key: string; value: string }> = []) {
  const writes: Array<{ key: string; value: string }> = [];
  const pool = {
    query: async (sql: string, params?: any[]) => {
      if (/SELECT key, value FROM app_settings/i.test(sql)) return { rows: seed };
      if (/INSERT INTO app_settings/i.test(sql)) {
        writes.push({ key: params![0], value: params![1] });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return { pool, writes };
}

const cfg = (env: Record<string, string> = {}) => ({ get: (k: string) => env[k] } as any);

test('telegramOwnerId() prefers the DB override over env', async () => {
  const { pool } = fakePool([{ key: 'TELEGRAM_OWNER_ID', value: '999' }]);
  const s = new SettingsService(pool as any, cfg({ TELEGRAM_OWNER_ID: '111' }));
  await s.whenLoaded();
  assert.equal(s.telegramOwnerId(), '999');
});

test('telegramOwnerId() falls back to env when no DB override', async () => {
  const { pool } = fakePool([]);
  const s = new SettingsService(pool as any, cfg({ TELEGRAM_OWNER_ID: '111' }));
  await s.whenLoaded();
  assert.equal(s.telegramOwnerId(), '111');
});

test('telegramOwnerId() is empty string when neither DB nor env set', async () => {
  const { pool } = fakePool([]);
  const s = new SettingsService(pool as any, cfg({}));
  await s.whenLoaded();
  assert.equal(s.telegramOwnerId(), '');
});

test('update() persists telegramOwnerId under TELEGRAM_OWNER_ID and takes effect live', async () => {
  const { pool, writes } = fakePool([]);
  const s = new SettingsService(pool as any, cfg({}));
  await s.whenLoaded();
  const fresh = await s.update({ telegramOwnerId: '424242' });
  assert.deepEqual(writes, [{ key: 'TELEGRAM_OWNER_ID', value: '424242' }]);
  assert.equal(s.telegramOwnerId(), '424242');
  assert.equal((fresh.telegram as any).ownerId, '424242');
});

test('get().telegram exposes the owner id', async () => {
  const { pool } = fakePool([{ key: 'TELEGRAM_OWNER_ID', value: '777' }]);
  const s = new SettingsService(pool as any, cfg({}));
  await s.whenLoaded();
  assert.equal((s.get().telegram as any).ownerId, '777');
});
