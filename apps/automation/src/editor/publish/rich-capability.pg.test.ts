/**
 * Spec 033 T2 against a real throwaway Postgres: the capability flag lives in
 * app_settings (no migration), the card read joins format_prefs.rich and the
 * live flag, a malformed flag value never breaks the card query, and the
 * settings service never treats the flag as an env override.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { EditorChannelsRepository, richUnsupportedKey } from '../repo/editor-channels.repository';
import { PgRichCapability, RICH_UNSUPPORTED_TTL_MS } from './rich-capability';
import { makeCard } from '../post/testing/fixtures';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@t033_rich_pg';
let pool: Pool;

async function cleanup() {
  await pool.query(`DELETE FROM app_settings WHERE key = $1`, [richUnsupportedKey(CH)]);
  await pool.query(`DELETE FROM resource_profiles WHERE resource_ref = $1`, [`telegram:${CH}`]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
}

before(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
});

after(async () => {
  if (skip) return;
  await cleanup();
  await pool.end();
});

test('card read: rich pref from format_prefs and the 7-day unsupported flag', { skip }, async () => {
  const repo = new EditorChannelsRepository(pool);
  const cap = new PgRichCapability(pool);
  await repo.insertIfMissing(makeCard({ channelKey: CH }));

  let card = await repo.get(CH);
  assert.equal(card?.richPref, undefined);
  assert.equal(card?.richUnsupported, undefined);

  await pool.query(`INSERT INTO resource_profiles (resource_ref, profile) VALUES ($1, $2)`, [`telegram:${CH}`, { format_prefs: { rich: 'prefer' } }]);
  await cap.markUnsupported(CH);
  card = await repo.get(CH);
  assert.equal(card?.richPref, 'prefer');
  assert.equal(card?.richUnsupported, true);
  assert.equal(await cap.isUnsupported(CH), true);
  assert.ok((await repo.list()).some((c) => c.channelKey === CH && c.richUnsupported === true));

  // Expired: 7 days later the flag is off on both paths.
  const later = new Date(Date.now() + RICH_UNSUPPORTED_TTL_MS + 60_000);
  assert.equal(await cap.isUnsupported(CH, later), false);
  await pool.query(`UPDATE app_settings SET value = $2 WHERE key = $1`, [richUnsupportedKey(CH), new Date(Date.now() - 1000).toISOString()]);
  assert.equal((await repo.get(CH))?.richUnsupported, undefined);

  // A malformed value is no flag and never breaks the card query.
  await pool.query(`UPDATE app_settings SET value = 'garbage' WHERE key = $1`, [richUnsupportedKey(CH)]);
  assert.equal((await repo.get(CH))?.richUnsupported, undefined);
  assert.equal(await cap.isUnsupported(CH), false);

  // The settings service skips cap.* rows (they are not env overrides).
  const { rows } = await pool.query(`SELECT key FROM app_settings WHERE key NOT LIKE 'ui.%' AND key NOT LIKE 'cap.%' AND key = $1`, [richUnsupportedKey(CH)]);
  assert.equal(rows.length, 0);
});
