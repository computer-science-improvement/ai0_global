/**
 * Spec 061 FR-006: an expired Meta session is a state. Detection of the error, the date in it, the account marked expired,
 * the keeper counting it, the hourly collector asking once a day, and the health text. Every port is faked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPIRED_PREFIX, expiredAtFrom, expiredErrorText, graphCodeSuffix, isExpiredSessionError, isTokenExpired,
} from './token-expiry';
import { MetaAccountsRepository } from './meta-accounts.repository';
import { runConnectionKeeper, type KeeperDeps } from './connection-keeper';
import { MetaStatsCollectorService } from '../stats/meta-stats-collector.service';
import { SecretsService } from '../common/crypto/secrets.service';
import { ResourceCatalog } from '../editor/agents/resource-catalog';

const NOW = new Date('2026-10-22T12:00:00Z');
const EXPIRED = 'verify failed: Error validating access token: Session has expired on Wednesday, 14-Oct-26 08:00:00 PDT. The current time is Thursday, 22-Oct-26 05:00:00 PDT.';

test('isExpiredSessionError: the Graph text, or code 190 with subcode 463 / 467; not a wrong target, a rate limit or a network failure', () => {
  assert.equal(isExpiredSessionError(EXPIRED), true);
  assert.equal(isExpiredSessionError('verify failed: Invalid OAuth access token (code 190, subcode 467)'), true);
  assert.equal(isExpiredSessionError('verify failed: Error validating access token (code 190, subcode 463)'), true);
  assert.equal(isExpiredSessionError('{"error":{"code":190,"error_subcode":463}}'), true);
  assert.equal(isExpiredSessionError('verify failed: Invalid OAuth access token (code 190, subcode 460)'), false, 'a password change is another subcode');
  assert.equal(isExpiredSessionError('verify failed: (#100) Unsupported get request (code 100)'), false);
  assert.equal(isExpiredSessionError('verify failed: timeout of 10000ms exceeded'), false);
  assert.equal(isExpiredSessionError(null), false);
});

test('graphCodeSuffix: only a code-190 error gets its code and subcode appended', () => {
  assert.equal(graphCodeSuffix({ response: { data: { error: { code: 190, error_subcode: 463 } } } }), ' (code 190, subcode 463)');
  assert.equal(graphCodeSuffix({ response: { data: { error: { code: 190 } } } }), ' (code 190)');
  assert.equal(graphCodeSuffix({ response: { data: { error: { code: 100 } } } }), '');
  assert.equal(graphCodeSuffix(new Error('x')), '');
});

test('expiredAtFrom: the date in the error with its zone; nothing when absent, unreadable or in the future', () => {
  assert.equal(expiredAtFrom(EXPIRED, NOW)?.toISOString(), '2026-10-14T15:00:00.000Z', 'PDT is UTC-7');
  assert.equal(expiredAtFrom('Session has expired on Friday, 02-Jan-26 01:02:03 GMT', NOW)?.toISOString(), '2026-01-02T01:02:03.000Z');
  assert.equal(expiredAtFrom('Session has expired', NOW), null);
  assert.equal(expiredAtFrom('Session has expired on Friday, 99-Xyz-26 01:02:03 PST', NOW), null);
  assert.equal(expiredAtFrom('Session has expired on Friday, 30-Oct-26 01:02:03 PST', NOW), null, 'a date in the future is not believed');
  assert.equal(expiredErrorText(new Date('2026-10-14T15:00:00Z')), `${EXPIRED_PREFIX}2026-10-14 — перепідключіть акаунт у /app/connections`);
});

test('isTokenExpired: marked by the session path, or the stored expiry has passed', () => {
  assert.equal(isTokenExpired({ verify_error: `${EXPIRED_PREFIX}2026-10-14 — x`, token_expires_at: null }, NOW), true);
  assert.equal(isTokenExpired({ verify_error: null, token_expires_at: new Date('2026-10-01T00:00:00Z') }, NOW), true);
  assert.equal(isTokenExpired({ verify_error: 'verify failed: wrong target', token_expires_at: new Date('2026-12-01T00:00:00Z') }, NOW), false);
  assert.equal(isTokenExpired({ verify_error: null, token_expires_at: null }, NOW), false);
});

test('markTokenExpired: token_expires_at is the date in the error (else now), the token is not valid, the verify error says it in Ukrainian', async () => {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const repo = new MetaAccountsRepository({ query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows: [] }; } } as any);
  await repo.markTokenExpired('a1', EXPIRED, NOW);
  assert.match(calls[0].sql, /token_expires_at = \$2, token_valid = false/);
  assert.deepEqual(calls[0].params, ['a1', new Date('2026-10-14T15:00:00Z'), `${EXPIRED_PREFIX}2026-10-14 — перепідключіть акаунт у /app/connections`, NOW]);
  await repo.markTokenExpired('a2', 'verify failed: Invalid OAuth access token (code 190, subcode 467)', NOW);
  assert.deepEqual(calls[1].params, ['a2', NOW, `${EXPIRED_PREFIX}2026-10-22 — перепідключіть акаунт у /app/connections`, NOW]);
});

// ── the keeper ──────────────────────────────────────────────────────────────

function keeper(o: { rows: any[]; refresh?: () => Promise<any>; inspect?: () => Promise<any> }) {
  const calls: string[] = [];
  const d: KeeperDeps = {
    meta: {
      list: async () => o.rows,
      setTokenEnc: async () => {}, setTokenMeta: async () => {},
      markVerifyError: async (id, e) => { calls.push(`err:${id}:${e}`); },
      markTokenExpired: async (id, e) => { calls.push(`expired:${id}:${e.slice(0, 30)}`); },
    },
    graph: {
      refreshThreadsToken: o.refresh ?? (async () => ({ accessToken: 'N', expiresInSec: 100 })),
      inspectToken: o.inspect ?? (async () => null),
    },
    bots: { list: async () => [], markVerified: async () => {}, markVerifyError: async () => {} },
    getMe: async () => ({ username: 'b', first_name: 'B' }),
    telegraph: { list: async () => [], markVerified: async () => {}, markVerifyError: async () => {} },
    telegraphInfo: async () => ({ short_name: 't' }),
    mtproto: { list: async () => [] },
    token: () => 'PLAIN', encrypt: (p) => `E(${p})`,
    inbox: { postOnce: async () => 1 }, day: () => '2026-10-22', retryMs: 0,
  };
  return { d, calls };
}
const acct = (id: string, p: Record<string, unknown> = {}) => ({ id, platform: 'threads', active: true, token_enc: 'enc', token_env: null, token_expires_at: null, verify_error: null, ...p }) as any;

test('keeper: a Threads refresh that fails with an expired session marks the account expired and counts it; another failure does not', async () => {
  const dead = keeper({ rows: [acct('t1')], refresh: async () => { throw new Error(`refreshThreadsToken failed: ${EXPIRED}`); } });
  const r = await runConnectionKeeper(dead.d, NOW);
  assert.deepEqual([r.threadsExpired, r.threadsFailed], [1, 0]);
  assert.equal(dead.calls.length, 1);
  assert.match(dead.calls[0], /^expired:t1:/);

  const other = keeper({ rows: [acct('t2')], refresh: async () => { throw new Error('token too new'); } });
  const o = await runConnectionKeeper(other.d, NOW);
  assert.deepEqual([o.threadsExpired, o.threadsFailed, other.calls], [0, 1, []]);
});

test('keeper: Facebook / Instagram upkeep that finds the session over is counted as metaExpired; an expired mark is not overwritten by the Threads text', async () => {
  const fb = keeper({ rows: [acct('f1', { platform: 'facebook' })], inspect: async () => { throw new Error(EXPIRED); } });
  const r = await runConnectionKeeper(fb.d, NOW);
  assert.equal(r.metaExpired, 1);
  assert.match(fb.calls[0], /^expired:f1:/);

  const marked = keeper({ rows: [acct('t3', { token_expires_at: new Date('2026-10-14T15:00:00Z'), verify_error: `${EXPIRED_PREFIX}2026-10-14 — x` })] });
  const m = await runConnectionKeeper(marked.d, NOW);
  assert.equal(m.threadsExpired, 1);
  assert.deepEqual(marked.calls, [], 'the Ukrainian expiry text stays');
});

// ── the hourly collector ────────────────────────────────────────────────────

function collector(accounts: any[], verify: () => Promise<any>) {
  const calls: string[] = [];
  const verifies: string[] = [];
  const repo = {
    list: async () => accounts,
    markVerified: async () => {},
    markVerifyError: async (id: string, m: string) => { calls.push(`err:${id}`); void m; },
    markTokenExpired: async (id: string) => { calls.push(`expired:${id}`); },
  };
  const graph = { verify: async (...a: any[]) => { verifies.push(String(a[1])); return verify(); }, fetchInsights: async () => [], fetchThreadsFollowers: async () => null };
  const svc = new MetaStatsCollectorService(
    repo as any, graph as any, { insert: async () => {} } as any, { upsertDay: async () => {} } as any,
    { get: () => 'tok' } as any, new SecretsService({ get: () => undefined } as any));
  return { svc, calls, verifies };
}
const ig = (id: string, p: Record<string, unknown> = {}) => ({ id, platform: 'instagram', target_id: `ig-${id}`, token_env: 'IG', active: true, ...p });
const ago = (h: number) => new Date(Date.now() - h * 3_600_000);

test('collector: a session-expired failure marks the account expired (not a plain verify error); other failures stay verify errors', async () => {
  const c = collector([ig('a'), ig('b')], (() => { let n = 0; return async () => { throw new Error(n++ === 0 ? EXPIRED : 'verify failed: network down'); }; })());
  await c.svc.runOnce();
  assert.deepEqual(c.calls, ['expired:a', 'err:b']);
});

test('collector: an expired account is asked once a day - skipped inside the day, tried again after it', async () => {
  const marked = { verify_error: `${EXPIRED_PREFIX}2026-10-14 — x`, token_expires_at: new Date('2026-10-14T15:00:00Z') };
  const fresh = collector([ig('a', { ...marked, last_verified_at: ago(2) }), ig('ok')], async () => ({ username: 'u', displayName: 'd', followers: 1, pictureUrl: null }));
  const r1 = await fresh.svc.runOnce();
  assert.deepEqual(fresh.verifies, ['ig-ok'], 'the expired account was checked 2 h ago');
  assert.equal(r1.accounts, 1);

  const due = collector([ig('a', { ...marked, last_verified_at: ago(25) })], async () => { throw new Error(EXPIRED); });
  await due.svc.runOnce();
  assert.deepEqual(due.verifies, ['ig-a'], 'a day later it is asked again');
  assert.deepEqual(due.calls, ['expired:a']);

  const never = collector([ig('a', { ...marked, last_verified_at: null })], async () => { throw new Error(EXPIRED); });
  await never.svc.runOnce();
  assert.deepEqual(never.verifies, ['ig-a']);
});

// ── health ──────────────────────────────────────────────────────────────────

test('health: an account the session path marked says «токен прострочено з <date>»; an old plain expiry keeps its English text', async () => {
  const row = (r: Record<string, unknown>) => ({ active: true, last_verified_at: new Date(NOW.getTime() - 3_600_000), verify_error: null, token_expires_at: null, token_valid: null, ...r });
  const catalog = (r: Record<string, unknown>) => new ResourceCatalog({ pool: { query: async () => ({ rows: [row(r)] }) } as any, now: () => NOW } as any);
  const text = expiredErrorText(new Date('2026-10-14T15:00:00Z'));
  const h = await catalog({ token_expires_at: new Date('2026-10-14T15:00:00Z'), token_valid: false, verify_error: text }).access('instagram:1');
  assert.deepEqual([h.state, h.detail], ['token_invalid', text]);
  assert.match(h.detail, /^токен прострочено з 2026-10-14/);
  const plain = await catalog({ token_expires_at: new Date('2026-10-17T00:00:00Z') }).access('threads:1');
  assert.equal(plain.detail, 'token expired on 2026-10-17');
});
