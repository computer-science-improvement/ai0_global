/**
 * Spec 061 FR-006 against a throwaway Postgres (init.sql + every migration, own database, dropped at the end):
 * `markTokenExpired` writes the real `meta_accounts` columns, and the resource catalog reads them back as an invalid token
 * with the Ukrainian text. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createProbeDb, type ProbeDb } from '../editor/agents/testing/probe-db';
import { MetaAccountsRepository } from './meta-accounts.repository';
import { ResourceCatalog } from '../editor/agents/resource-catalog';
import { isTokenExpired } from './token-expiry';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let db: ProbeDb;
let pool: Pool;

before(async () => {
  if (!url) return;
  db = await createProbeDb(url, 'p061_tokens');
  pool = db.pool;
});
after(async () => {
  if (!url) return;
  await db.drop();
});

test('markTokenExpired marks the account; health says it in Ukrainian; a fresh verify (markVerified + new expiry) clears the mark', { skip }, async () => {
  const { rows } = await pool.query(
    `INSERT INTO meta_accounts (platform, account_id, token_env, target_id) VALUES ('instagram', 'ig-061', 'IG_061', 'ig-target') RETURNING id`);
  const id = rows[0].id as string;
  const repo = new MetaAccountsRepository(pool as any);
  const now = new Date('2026-10-22T12:00:00Z');
  await repo.markTokenExpired(id, 'verify failed: Error validating access token: Session has expired on Wednesday, 14-Oct-26 08:00:00 PDT. The current time is X.', now);

  const row = (await pool.query(`SELECT * FROM meta_accounts WHERE id = $1`, [id])).rows[0];
  assert.equal(new Date(row.token_expires_at).toISOString(), '2026-10-14T15:00:00.000Z');
  assert.equal(row.token_valid, false);
  assert.equal(row.verify_error, 'токен прострочено з 2026-10-14 — перепідключіть акаунт у /app/connections');
  assert.equal(new Date(row.last_verified_at).toISOString(), now.toISOString());
  assert.equal(isTokenExpired(row, now), true);

  const health = await new ResourceCatalog({ pool: pool as any, now: () => now } as any).access(`instagram:${id}`);
  assert.deepEqual([health.state, health.detail], ['token_invalid', row.verify_error]);

  // A reconnect: the new token's debug_token data and a good verify end the state.
  await repo.setTokenMeta(id, { type: 'PAGE', expiresAt: new Date('2026-12-30T00:00:00Z'), dataAccessExpiresAt: null, scopes: [], isValid: true });
  await repo.markVerified(id, { username: 'u', display_name: 'd', followers: 1, picture_url: null });
  const after = (await pool.query(`SELECT * FROM meta_accounts WHERE id = $1`, [id])).rows[0];
  assert.equal(isTokenExpired(after, now), false);
  assert.equal((await new ResourceCatalog({ pool: pool as any, now: () => now } as any).access(`instagram:${id}`)).state, 'ok');
});

test('markTokenExpired without a date in the error uses now', { skip }, async () => {
  const { rows } = await pool.query(
    `INSERT INTO meta_accounts (platform, account_id, token_env, target_id) VALUES ('threads', 'th-061', 'TH_061', 'th-target') RETURNING id`);
  const now = new Date('2026-10-22T12:00:00Z');
  await new MetaAccountsRepository(pool as any).markTokenExpired(rows[0].id, 'refreshThreadsToken failed: Invalid OAuth access token (code 190, subcode 467)', now);
  const row = (await pool.query(`SELECT token_expires_at, verify_error FROM meta_accounts WHERE id = $1`, [rows[0].id])).rows[0];
  assert.equal(new Date(row.token_expires_at).toISOString(), now.toISOString());
  assert.match(row.verify_error, /^токен прострочено з 2026-10-22/);
});
