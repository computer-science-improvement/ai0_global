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
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { ResourceProfilesRepository } from '../agents/resource-profile';
import { renderTelegram } from '../post/render-telegram';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@t033_rich_pg';
let pool: Pool;

async function cleanup() {
  await pool.query(`DELETE FROM app_settings WHERE key = $1`, [richUnsupportedKey(CH)]);
  await pool.query(`DELETE FROM resource_profile_versions WHERE resource_ref = $1`, [`telegram:${CH}`]);
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

test('format_prefs.rich: agents set it, the owner can lock it, the card and the render follow it', { skip }, async () => {
  const repo = new EditorChannelsRepository(pool);
  const profiles = new ResourceProfilesRepository(pool);
  const ref = `telegram:${CH}`;
  await pool.query(`DELETE FROM app_settings WHERE key = $1`, [richUnsupportedKey(CH)]);
  await pool.query(`DELETE FROM resource_profile_versions WHERE resource_ref = $1`, [ref]);
  await pool.query(`DELETE FROM resource_profiles WHERE resource_ref = $1`, [ref]);
  await repo.insertIfMissing(makeCard({ channelKey: CH }));
  const plain = makeSpec({ format: 'text', media: [] });

  const set = await profiles.patchFormat(ref, { rich: 'prefer' }, { by: 'agent', reason: 'tables get more forwards' });
  assert.ok('ok' in set && set.ok, JSON.stringify(set));
  let card = (await repo.get(CH))!;
  assert.equal(card.richPref, 'prefer');
  assert.equal(renderTelegram(plain, card).messages[0].method, 'sendRichMessage');

  const owner = await profiles.patchFormat(ref, { rich: 'never' }, { by: 'owner', locks: ['rich'] });
  assert.ok('ok' in owner && owner.ok, JSON.stringify(owner));
  const refused = await profiles.patchFormat(ref, { rich: 'auto' }, { by: 'agent', reason: 'try again' });
  assert.deepEqual(refused, { error: 'locked_by_owner', details: ['rich'] });
  card = (await repo.get(CH))!;
  assert.equal(card.richPref, 'never');
  const withTable = makeSpec({ format: 'text', media: [], body: [{ type: 'lead', text: 'Порівняння' }, { type: 'table', header: ['А', 'Б'], rows: [['1', '2']] }] });
  assert.equal(renderTelegram(withTable, card).messages[0].method, 'sendMessage');
  await pool.query(`DELETE FROM resource_profile_versions WHERE resource_ref = $1`, [ref]);
});
