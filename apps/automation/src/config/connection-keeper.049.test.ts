/** Spec 049 FR-001: the daily connection upkeep — no network, every port faked. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runConnectionKeeper, THREADS_REFRESH_DAYS, type KeeperDeps } from './connection-keeper';

const DAY = 86_400_000;
const NOW = new Date('2026-10-18T05:40:00Z');

const meta = (id: string, p: Record<string, unknown> = {}) => ({
  id, platform: 'threads', active: true, token_enc: 'enc:v1:x', token_env: null, token_expires_at: null, verify_error: null, ...p,
}) as any;

function deps(o: Partial<KeeperDeps> & { metaRows?: any[]; botRows?: any[]; telegraphRows?: any[]; mtprotoRows?: any[]; tiktokRows?: any[] } = {}) {
  const calls: string[] = [];
  const notes: any[] = [];
  const d: KeeperDeps = {
    meta: {
      list: async () => o.metaRows ?? [],
      setTokenEnc: async (id, enc) => { calls.push(`enc:${id}:${enc}`); },
      setTokenMeta: async (id, info) => { calls.push(`meta:${id}:${info.type}:${info.expiresAt?.toISOString().slice(0, 10) ?? ''}:${info.isValid}`); },
      markVerifyError: async (id, e) => { calls.push(`err:${id}:${e}`); },
    },
    graph: {
      refreshThreadsToken: async () => ({ accessToken: 'NEW', expiresInSec: 60 * 86400 }),
      inspectToken: async () => ({ type: 'PAGE', expiresAt: null, dataAccessExpiresAt: null, scopes: [], isValid: true }),
    },
    bots: {
      list: async () => o.botRows ?? [],
      markVerified: async (id) => { calls.push(`bot-ok:${id}`); },
      markVerifyError: async (id, e) => { calls.push(`bot-err:${id}:${e}`); },
    },
    getMe: async () => ({ username: 'b', first_name: 'B' }),
    telegraph: {
      list: async () => o.telegraphRows ?? [],
      markVerified: async (id) => { calls.push(`tgph-ok:${id}`); },
      markVerifyError: async (id, e) => { calls.push(`tgph-err:${id}:${e}`); },
    },
    telegraphInfo: async () => ({ short_name: 't' }),
    tiktok: { list: async () => o.tiktokRows ?? [], getValidAccessToken: async (id) => { calls.push(`tt:${id}`); return 'tok'; } },
    mtproto: { list: async () => o.mtprotoRows ?? [] },
    token: (r) => (r.token_enc ? 'PLAIN' : null),
    encrypt: (p) => `E(${p})`,
    inbox: { postOnce: async (i) => { notes.push(i); return notes.length; } },
    changed: async (kind, id) => { calls.push(`changed:${kind}:${id}`); },
    day: () => '2026-10-18',
    retryMs: 0,
    ...o,
  };
  return { d, calls, notes };
}

test('Threads: refreshed within 10 days of expiry or with an unknown expiry; not when far off; an expired token is stated, not refreshed', async () => {
  const w = deps({ metaRows: [
    meta('soon', { token_expires_at: new Date(NOW.getTime() + 5 * DAY) }),
    meta('unknown'),
    meta('far', { token_expires_at: new Date(NOW.getTime() + (THREADS_REFRESH_DAYS + 5) * DAY) }),
    meta('dead', { token_expires_at: new Date('2026-08-17T00:00:00Z') }),
    meta('off', { active: false, token_expires_at: new Date(NOW.getTime() + DAY) }),
  ] });
  const r = await runConnectionKeeper(w.d, NOW);
  assert.deepEqual([r.threadsRefreshed, r.threadsExpired], [2, 1]);
  assert.ok(w.calls.includes('enc:soon:E(NEW)'));
  assert.ok(w.calls.includes('meta:soon:THREADS:2026-12-17:true'), 'the new expiry is stored');
  assert.ok(!w.calls.some((c) => c.startsWith('enc:far') || c.includes(':off')));
  assert.ok(w.calls.includes('err:dead:Threads token expired on 2026-08-17 — reconnect the account in /app/connections'));
  assert.ok(!w.calls.some((c) => c.startsWith('enc:dead')));
});

test('Threads: a failed refresh is not a broken connection; no encryption key means no refresh', async () => {
  const failing = deps({ metaRows: [meta('a', { token_expires_at: new Date(NOW.getTime() + 3 * DAY) })] });
  failing.d.graph.refreshThreadsToken = async () => { throw new Error('token too new'); };
  const r = await runConnectionKeeper(failing.d, NOW);
  assert.equal(r.threadsFailed, 1);
  assert.ok(!failing.calls.some((c) => c.startsWith('err:')), 'the health check flags it when the expiry nears');

  const noKey = deps({ metaRows: [meta('a', { token_expires_at: new Date(NOW.getTime() + 3 * DAY) })], encrypt: () => { throw new Error('TOKEN_ENCRYPTION_KEY not set'); } });
  let refreshed = false;
  noKey.d.graph.refreshThreadsToken = async () => { refreshed = true; return { accessToken: 'x', expiresInSec: 1 }; };
  assert.equal((await runConnectionKeeper(noKey.d, NOW)).threadsFailed, 1);
  assert.equal(refreshed, false, 'a refreshed token that cannot be stored would be lost');
});

test('Facebook / Instagram: debug_token metadata (expiry, validity) is stored for the health check', async () => {
  const w = deps({ metaRows: [meta('ig', { platform: 'instagram' })] });
  assert.equal((await runConnectionKeeper(w.d, NOW)).metaInspected, 1);
  assert.ok(w.calls.includes('meta:ig:PAGE::true'));
});

test('bots and Telegraph: one retry, then marked broken with one Inbox note a day; a recovery clears the error', async () => {
  let tries = 0;
  const w = deps({
    botRows: [{ id: 'b1', bot_id: '123', username: 'ai0_bot', token_enc: 'x', token_env: null, active: true, verify_error: null }],
    telegraphRows: [{ id: 't1', account_id: 'acc', short_name: 'ai0', token_enc: 'x', token_env: null, active: true, verify_error: 'old error' }],
    getMe: async () => { tries++; throw new Error('Unauthorized'); },
  });
  const r = await runConnectionKeeper(w.d, NOW);
  assert.equal(tries, 2, 'retried once');
  assert.equal(r.botsBroken, 1);
  assert.ok(w.calls.includes('bot-err:b1:Unauthorized'));
  assert.ok(w.calls.includes('changed:bot:b1'), 'the state flipped');
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0].title, /Bot @ai0_bot is broken/);
  assert.deepEqual([w.notes[0].refType, w.notes[0].refId], ['resource_day', 'bot:b1|2026-10-18']);
  assert.ok(w.calls.includes('tgph-ok:t1') && w.calls.includes('changed:telegraph:t1'));

  let n = 0;
  const flaky = deps({ botRows: [{ id: 'b2', bot_id: '1', username: null, token_enc: 'x', token_env: null, active: true, verify_error: null }],
    getMe: async () => { if (n++ === 0) throw new Error('ETIMEDOUT'); return { username: 'b', first_name: 'B' }; } });
  await runConnectionKeeper(flaky.d, NOW);
  assert.ok(flaky.calls.includes('bot-ok:b2'), 'a single network blip is not a broken bot');
});

test('TikTok accounts are kept fresh; MTProto sessions are reported from their stored state, never reconnected', async () => {
  const w = deps({
    tiktokRows: [{ id: 'k1', active: true }, { id: 'k2', active: false }],
    mtprotoRows: [
      { id: 'm1', label: 'tracker', role: 'tracker', username: null, active: true, verify_error: 'AUTH_KEY_UNREGISTERED' },
      { id: 'm2', label: 'agent', role: 'agent', username: 'me', active: true, verify_error: null },
    ],
  });
  await runConnectionKeeper(w.d, NOW);
  assert.deepEqual(w.calls.filter((c) => c.startsWith('tt:')), ['tt:k1']);
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0].title, /MTProto session tracker \(tracker\) is broken/);
});
