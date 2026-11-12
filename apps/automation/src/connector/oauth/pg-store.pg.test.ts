/**
 * PgOAuthStore + PgAudit against a throwaway database (migration 105 applied). Skipped unless EDITOR_PG_TEST_URL is set.
 * The database is created and dropped here (style A, prefix p103a_); never point the URL at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMigratedDb, type FreshDb } from '../../editor/sysadmin/testing/fresh-db';
import { PgAudit } from '../audit/audit';
import { ClientRegistry } from './clients';
import { sha256Hex } from './crypto';
import { OAuthService } from './oauth.service';
import { PgOAuthStore } from './pg-store';
import { HOSTED_REDIRECT, URLS, SESSION, Clock, failingFetcher, pkce } from './testing/fixtures';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let db: FreshDb;
let store: PgOAuthStore;

before(async () => {
  if (!url) return;
  db = await createMigratedDb(url, 'p103a_store');
  store = new PgOAuthStore(db.pool);
});
after(async () => { if (db) await db.drop(); });

const T0 = new Date('2026-11-12T10:00:00Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);

test('clients: upsert, DCR count, list with active grants, revoke cascades to grants and tokens', { skip }, async () => {
  const c = await store.upsertClient({ clientId: 'dcr_1', kind: 'dcr', name: 'One', redirectUris: [HOSTED_REDIRECT], createdIp: '1.1.1.1' }, T0);
  assert.equal(c.kind, 'dcr');
  assert.deepEqual(c.redirectUris, [HOSTED_REDIRECT]);
  await store.upsertClient({ clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata', kind: 'cimd', name: 'Claude', redirectUris: [HOSTED_REDIRECT] }, T0);
  assert.equal(await store.countActiveDcr(), 1);

  const g = randomUUID();
  await store.createGrant({ id: g, clientId: 'dcr_1', scope: 'mcp:read', resource: URLS.resource }, T0);
  await store.insertToken({ tokenHash: 'h_rt', kind: 'refresh', grantId: g, clientId: 'dcr_1', scope: 'mcp:read', resource: URLS.resource, redirectUri: null, codeChallenge: null, expiresAt: plus(86400_000) }, T0);
  const list = await store.listClients();
  assert.equal(list.find((x) => x.clientId === 'dcr_1')?.activeGrants, 1);
  const grants = await store.listGrants();
  assert.equal(grants.find((x) => x.id === g)?.clientName, 'One');
  assert.equal(grants.find((x) => x.id === g)?.expiresAt?.getTime(), plus(86400_000).getTime());

  const r = await store.revokeClient(c.id, plus(1000));
  assert.deepEqual(r, { found: true, revoked: 1 });
  assert.ok((await store.getGrant(g))?.revokedAt);
  assert.ok((await store.getToken('h_rt'))?.revokedAt);
  assert.equal(await store.countActiveDcr(), 0);
  assert.equal((await store.listClients()).some((x) => x.clientId === 'dcr_1'), false);
  assert.deepEqual(await store.revokeClient(randomUUID(), T0), { found: false, revoked: 0 });
});

test('a CIMD client that was revoked comes back on the next upsert; a DCR client stays revoked', { skip }, async () => {
  const cimd = 'https://claude.ai/oauth/claude-code-client-metadata';
  const a = await store.upsertClient({ clientId: cimd, kind: 'cimd', name: 'Claude Code', redirectUris: [] }, T0);
  await store.revokeClient(a.id, T0);
  assert.equal((await store.upsertClient({ clientId: cimd, kind: 'cimd', name: 'Claude Code', redirectUris: [] }, plus(1))).revokedAt, null);
  const d = await store.upsertClient({ clientId: 'dcr_2', kind: 'dcr', name: 'Two', redirectUris: [] }, T0);
  await store.revokeClient(d.id, T0);
  assert.ok((await store.upsertClient({ clientId: 'dcr_2', kind: 'dcr', name: 'Two', redirectUris: [] }, plus(1))).revokedAt);
});

test('requests: a decision is atomic, only for a pending unexpired request', { skip }, async () => {
  const base = { clientId: 'dcr_x', redirectUri: HOSTED_REDIRECT, codeChallenge: 'c'.repeat(43), scope: 'mcp:read', state: 's', resource: URLS.resource };
  await store.insertRequest({ ...base, idHash: 'req_1', expiresAt: plus(600_000) }, T0);
  const results = await Promise.all([1, 2, 3, 4].map(() => store.decideRequest('req_1', 'allow', plus(1000))));
  assert.equal(results.filter(Boolean).length, 1, 'exactly one decision wins');
  assert.equal((await store.getRequest('req_1'))?.decision, 'allow');
  await store.insertRequest({ ...base, idHash: 'req_2', expiresAt: plus(1000) }, T0);
  assert.equal(await store.decideRequest('req_2', 'allow', plus(2000)), null, 'expired');
  assert.equal(await store.getRequest('nope'), null);
});

test('codes: single use is one UPDATE … RETURNING, even under concurrency; the grant id is recorded', { skip }, async () => {
  await store.upsertClient({ clientId: 'dcr_c', kind: 'dcr', name: 'C', redirectUris: [] }, T0);
  await store.insertToken({ tokenHash: 'code_1', kind: 'code', grantId: null, clientId: 'dcr_c', scope: 'mcp:read', resource: URLS.resource, redirectUri: HOSTED_REDIRECT, codeChallenge: 'x', expiresAt: plus(300_000) }, T0);
  const grants = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  for (const id of grants) await store.createGrant({ id, clientId: 'dcr_c', scope: 'mcp:read', resource: URLS.resource }, T0);
  const res = await Promise.all(grants.map((id) => store.consumeCode('code_1', id, plus(1000))));
  assert.equal(res.filter(Boolean).length, 1);
  const winner = res.findIndex(Boolean);
  const row = await store.getToken('code_1');
  assert.ok(row?.usedAt);
  assert.equal(row?.grantId, grants[winner]);
  for (const id of grants) if (id !== grants[winner]) await store.deleteGrant(id);
  assert.equal(await store.getGrant(grants[(winner + 1) % 4]), null);

  await store.insertToken({ tokenHash: 'code_exp', kind: 'code', grantId: null, clientId: 'dcr_c', scope: 'mcp:read', resource: URLS.resource, redirectUri: HOSTED_REDIRECT, codeChallenge: 'x', expiresAt: plus(1000) }, T0);
  assert.equal(await store.consumeCode('code_exp', grants[winner], plus(5000)), null, 'expired');
});

test('refresh rotation is atomic; grant revoke kills tokens; revoke-since keeps the exempt token', { skip }, async () => {
  const g = randomUUID();
  await store.upsertClient({ clientId: 'dcr_r', kind: 'dcr', name: 'R', redirectUris: [] }, T0);
  await store.createGrant({ id: g, clientId: 'dcr_r', scope: 'mcp:read mcp:write', resource: URLS.resource }, T0);
  const tok = (hash: string, kind: 'access' | 'refresh', at: Date) => store.insertToken({ tokenHash: hash, kind, grantId: g, clientId: 'dcr_r', scope: 'mcp:read', resource: URLS.resource, redirectUri: null, codeChallenge: null, expiresAt: plus(86400_000) }, at);
  await tok('rt_a', 'refresh', T0);
  const rotated = await Promise.all([1, 2, 3].map((i) => store.consumeRefresh('rt_a', `rt_b${i}`, plus(1000))));
  assert.equal(rotated.filter(Boolean).length, 1);
  assert.ok((await store.getToken('rt_a'))?.usedAt);

  await tok('rt_b', 'refresh', plus(1000));
  await tok('at_b', 'access', plus(1000));
  await store.revokeGrantTokensSince(g, plus(1000), plus(2000), 'rt_a');
  assert.ok((await store.getToken('rt_b'))?.revokedAt);
  assert.ok((await store.getToken('at_b'))?.revokedAt);
  assert.equal((await store.getToken('rt_a'))?.revokedAt, null, 'the exempt token is untouched');

  assert.equal(await store.revokeGrant(g, 'refresh_reuse', plus(3000)), true);
  assert.equal(await store.revokeGrant(g, 'again', plus(3000)), false);
  assert.equal((await store.getGrant(g))?.revokedReason, 'refresh_reuse');
  assert.ok((await store.getToken('rt_a'))?.revokedAt);
  assert.equal(await store.consumeRefresh('rt_a', 'x', plus(4000)), false);
});

test('grants: touch, revoke all', { skip }, async () => {
  const a = randomUUID(), b = randomUUID();
  await store.createGrant({ id: a, clientId: 'dcr_r', scope: 'mcp:read', resource: URLS.resource }, T0);
  await store.createGrant({ id: b, clientId: 'dcr_r', scope: 'mcp:read', resource: URLS.resource }, T0);
  await store.touchGrant(a, '8.8.8.8', plus(500));
  const g = await store.getGrant(a);
  assert.equal(g?.lastIp, '8.8.8.8');
  assert.equal(g?.lastUsedAt?.getTime(), plus(500).getTime());
  assert.ok((await store.revokeAllGrants('revoked_by_owner', plus(900))) >= 2);
  assert.equal((await store.listGrants()).length, 0);
});

test('purge drops tokens and requests expired for more than a day, keeps the rest', { skip }, async () => {
  const old = new Date('2026-01-01T00:00:00Z');
  await store.insertToken({ tokenHash: 'old_code', kind: 'code', grantId: null, clientId: 'dcr_c', scope: 's', resource: URLS.resource, redirectUri: null, codeChallenge: null, expiresAt: old }, old);
  await store.insertRequest({ idHash: 'old_req', clientId: 'dcr_c', redirectUri: HOSTED_REDIRECT, codeChallenge: 'c', scope: 's', state: null, resource: URLS.resource, expiresAt: old }, old);
  await store.purge(T0);
  assert.equal(await store.getToken('old_code'), null);
  assert.equal(await store.getRequest('old_req'), null);
  assert.ok(await store.getToken('code_1'), 'recent rows stay');
});

test('the OAuth service on PG: code exchange, rotation, reuse revokes, hashes only at rest, audit rows', { skip }, async () => {
  const clock = new Clock();
  const audit = new PgAudit(db.pool);
  const clients = new ClientRegistry(store, failingFetcher, clock.now, audit);
  const oauth = new OAuthService(store, clients, audit, clock.now);
  const reg = await clients.register({ client_name: 'PG client', redirect_uris: [HOSTED_REDIRECT] }, '4.4.4.4');
  const clientId = reg.client_id as string;
  const { verifier, challenge } = pkce();
  const a = await oauth.authorize({ client_id: clientId, redirect_uri: HOSTED_REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'S' }, URLS);
  assert.ok(a.kind === 'redirect');
  const reqId = new URL(a.location).searchParams.get('request')!;
  const d = await oauth.decide(reqId, { decision: 'allow' }, URLS, SESSION);
  const code = new URL(d.redirect).searchParams.get('code')!;
  const form = { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: HOSTED_REDIRECT };
  const tok = await oauth.token(form, URLS, { ip: '4.4.4.4' });

  const dump = await db.pool.query(`SELECT token_hash FROM mcp_oauth_tokens`);
  const hashes = dump.rows.map((r) => r.token_hash as string);
  assert.ok(hashes.includes(sha256Hex(tok.access_token)));
  assert.ok(!hashes.some((h) => h.startsWith('ai0mcp_')), 'no raw token in the table');
  const reqRows = await db.pool.query(`SELECT id_hash FROM mcp_oauth_requests WHERE id_hash = $1`, [sha256Hex(reqId)]);
  assert.equal(reqRows.rows.length, 1);

  const principal = await oauth.authenticateAccess(tok.access_token, URLS);
  assert.equal(principal?.clientName, 'PG client');

  clock.advance(1000);
  const next = await oauth.token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tok.refresh_token }, URLS, { ip: null });
  assert.ok(await oauth.authenticateAccess(next.access_token, URLS));

  // replaying the code revokes the grant: both pairs die
  await assert.rejects(oauth.token(form, URLS, { ip: '6.6.6.6' }), /already used/);
  assert.equal(await oauth.authenticateAccess(next.access_token, URLS), null);
  assert.equal(await oauth.authenticateAccess(tok.access_token, URLS), null);

  const events = (await db.pool.query(`SELECT event, summary FROM mcp_audit ORDER BY id`)).rows.map((r) => r.event);
  for (const e of ['register', 'consent_allow', 'token_issued', 'refresh_reuse']) assert.ok(events.includes(e), e);
  const list = await audit.list(10);
  assert.ok(list.length >= 4);
  assert.equal(list.some((i) => i.clientName === 'PG client'), true);
});

test('audit: the tool row stores what it is given, capped; a failing write never throws', { skip }, async () => {
  const audit = new PgAudit(db.pool);
  await audit.record({ event: 'tool_call', tool: 'get_post', ok: false, error: 'e'.repeat(1000), summary: 's'.repeat(1000), durationMs: 12, ip: '1.1.1.1' });
  const row = (await db.pool.query(`SELECT error, summary, duration_ms FROM mcp_audit WHERE tool = 'get_post'`)).rows[0];
  assert.equal(row.error.length, 300);
  assert.equal(row.summary.length, 300);
  const broken = new PgAudit({ query: async () => { throw new Error('db down'); } } as any);
  await broken.record({ event: 'tool_call' });
});
