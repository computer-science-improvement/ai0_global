import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OAuthError } from './errors';
import { REFRESH_GRACE_MS } from './constants';
import { sha256Hex } from './crypto';
import { HOSTED_REDIRECT, SESSION, URLS, getCode, makeOAuth, pkce, registerDcr } from './testing/fixtures';

async function rejects(p: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof OAuthError, `expected OAuthError, got ${String(e)}`);
    assert.equal(e.code, code);
    if (status) assert.equal(e.status, status);
    return true;
  });
}

const tokenReq = (clientId: string, code: string, verifier: string, extra: Record<string, unknown> = {}) => ({
  grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: HOSTED_REDIRECT, ...extra,
});

async function connected(scope?: string) {
  const h = makeOAuth();
  const clientId = await registerDcr(h.clients);
  const c = await getCode(h, clientId, { scope });
  const tok = await h.oauth.token(tokenReq(clientId, c.code, c.verifier), URLS, { ip: '1.1.1.1' });
  return { h, clientId, tok };
}

// ── authorize ────────────────────────────────────────────────────────────────

test('authorize: stores the request and sends the browser to the consent page', async () => {
  const h = makeOAuth();
  const clientId = await registerDcr(h.clients);
  const { challenge } = pkce();
  const r = await h.oauth.authorize({ client_id: clientId, redirect_uri: HOSTED_REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'abc' }, URLS);
  assert.equal(r.kind, 'redirect');
  assert.ok(r.kind === 'redirect' && r.location.startsWith('https://dev.ai0.global/app/oauth/consent?request='));
});

test('authorize: PKCE is mandatory and only S256 (plain and a missing challenge are refused by redirect)', async () => {
  const h = makeOAuth();
  const clientId = await registerDcr(h.clients);
  const base = { client_id: clientId, redirect_uri: HOSTED_REDIRECT, response_type: 'code', state: 's1' };
  const { challenge } = pkce();
  for (const extra of [{ code_challenge: challenge, code_challenge_method: 'plain' }, { code_challenge: challenge }, { code_challenge_method: 'S256' }, { code_challenge: 'short', code_challenge_method: 'S256' }]) {
    const r = await h.oauth.authorize({ ...base, ...extra }, URLS);
    assert.ok(r.kind === 'redirect');
    const u = new URL(r.location);
    assert.equal(u.origin + u.pathname, HOSTED_REDIRECT);
    assert.equal(u.searchParams.get('error'), 'invalid_request');
    assert.equal(u.searchParams.get('state'), 's1');
    assert.equal(u.searchParams.get('iss'), URLS.issuer);
  }
});

test('authorize: unknown client and bad redirect_uri show a page and never redirect', async () => {
  const h = makeOAuth();
  const clientId = await registerDcr(h.clients);
  const { challenge } = pkce();
  const q = { response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' };
  assert.equal((await h.oauth.authorize({ ...q, client_id: 'nope', redirect_uri: HOSTED_REDIRECT }, URLS)).kind, 'page');
  assert.equal((await h.oauth.authorize({ ...q, client_id: clientId, redirect_uri: 'https://evil.example/cb' }, URLS)).kind, 'page');
  assert.equal((await h.oauth.authorize({ ...q, client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback/' }, URLS)).kind, 'page');
});

test('authorize: scope subset, empty means both, offline_access ignored, unknown scope refused', async () => {
  const h = makeOAuth();
  assert.deepEqual(h.oauth.parseScopes(undefined), ['mcp:read', 'mcp:write']);
  assert.deepEqual(h.oauth.parseScopes(''), ['mcp:read', 'mcp:write']);
  assert.deepEqual(h.oauth.parseScopes('mcp:read'), ['mcp:read']);
  assert.deepEqual(h.oauth.parseScopes('offline_access mcp:read'), ['mcp:read']);
  assert.deepEqual(h.oauth.parseScopes('offline_access'), ['mcp:read', 'mcp:write']);
  assert.equal(h.oauth.parseScopes('mcp:read admin'), null);
  const clientId = await registerDcr(h.clients);
  const { challenge } = pkce();
  const r = await h.oauth.authorize({ client_id: clientId, redirect_uri: HOSTED_REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp:read admin' }, URLS);
  assert.ok(r.kind === 'redirect' && new URL(r.location).searchParams.get('error') === 'invalid_scope');
});

test('authorize: resource must be the canonical one; one trailing slash is tolerated', async () => {
  const h = makeOAuth();
  const clientId = await registerDcr(h.clients);
  const { challenge } = pkce();
  const q = { client_id: clientId, redirect_uri: HOSTED_REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' };
  const ok1 = await h.oauth.authorize({ ...q, resource: URLS.resource }, URLS);
  const ok2 = await h.oauth.authorize({ ...q, resource: `${URLS.resource}/` }, URLS);
  const bad = await h.oauth.authorize({ ...q, resource: 'https://other.example/api/mcp' }, URLS);
  const bad2 = await h.oauth.authorize({ ...q, resource: `${URLS.resource}//` }, URLS);
  assert.ok(ok1.kind === 'redirect' && new URL(ok1.location).pathname === '/app/oauth/consent');
  assert.ok(ok2.kind === 'redirect' && new URL(ok2.location).pathname === '/app/oauth/consent');
  assert.ok(bad.kind === 'redirect' && new URL(bad.location).searchParams.get('error') === 'invalid_target');
  assert.ok(bad2.kind === 'redirect' && new URL(bad2.location).searchParams.get('error') === 'invalid_target');
});

// ── consent ──────────────────────────────────────────────────────────────────

async function pendingRequest(h: ReturnType<typeof makeOAuth>, clientId: string) {
  const { challenge } = pkce();
  const a = await h.oauth.authorize({ client_id: clientId, redirect_uri: HOSTED_REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'S' }, URLS);
  assert.ok(a.kind === 'redirect');
  return new URL(a.location).searchParams.get('request')!;
}

test('consent info: client, redirect host and scope labels; unknown id 404; expired 410', async () => {
  const h = makeOAuth();
  const clientId = await registerDcr(h.clients);
  const id = await pendingRequest(h, clientId);
  const info = await h.oauth.requestInfo(id);
  assert.equal(info.client.name, 'Test client');
  assert.equal(info.client.redirectHost, 'claude.ai');
  assert.equal(info.client.loopback, false);
  assert.deepEqual(info.scopes.map((s) => s.scope), ['mcp:read', 'mcp:write']);
  assert.match(info.scopes[0].label, /See channels/);
  await rejects(h.oauth.requestInfo('unknown'), 'request_not_found', 404);
  h.clock.advance(10 * 60 * 1000 + 1);
  await rejects(h.oauth.requestInfo(id), 'request_gone', 410);
});

test('consent decision: only a real session (or local dev bypass); a TRACKING_TOKEN bearer is refused', async () => {
  const h = makeOAuth();
  const clientId = await registerDcr(h.clients);
  const id = await pendingRequest(h, clientId);
  await rejects(h.oauth.decide(id, { decision: 'allow' }, URLS, { ...SESSION, authMethod: 'bearer' }), 'session_required', 403);
  await rejects(h.oauth.decide(id, { decision: 'allow' }, URLS, { ...SESSION, authMethod: 'dev', production: true }), 'session_required', 403);
  const ok = await h.oauth.decide(id, { decision: 'allow' }, URLS, { ...SESSION, authMethod: 'dev', production: false });
  assert.match(ok.redirect, /code=ai0mcp_c_/);
});

test('consent decision: Origin, if present, must be the public origin', async () => {
  const h = makeOAuth();
  const clientId = await registerDcr(h.clients);
  const id = await pendingRequest(h, clientId);
  await rejects(h.oauth.decide(id, { decision: 'allow' }, URLS, { ...SESSION, origin: 'https://evil.example' }), 'bad_origin', 403);
  const ok = await h.oauth.decide(id, { decision: 'allow' }, URLS, { ...SESSION, origin: URLS.origin });
  assert.ok(ok.redirect.startsWith(HOSTED_REDIRECT));
});

test('consent decision: expired and already-decided requests are 410, unknown is 404', async () => {
  const h = makeOAuth();
  const clientId = await registerDcr(h.clients);
  const id = await pendingRequest(h, clientId);
  await rejects(h.oauth.decide('nope', { decision: 'allow' }, URLS, SESSION), 'request_not_found', 404);
  await h.oauth.decide(id, { decision: 'allow' }, URLS, SESSION);
  await rejects(h.oauth.decide(id, { decision: 'allow' }, URLS, SESSION), 'request_gone', 410);
  const id2 = await pendingRequest(h, clientId);
  h.clock.advance(10 * 60 * 1000 + 1);
  await rejects(h.oauth.decide(id2, { decision: 'allow' }, URLS, SESSION), 'request_gone', 410);
});

test('consent decision: deny redirects with access_denied, state and iss; allow carries state and iss', async () => {
  const h = makeOAuth();
  const clientId = await registerDcr(h.clients);
  const denied = await h.oauth.decide(await pendingRequest(h, clientId), { decision: 'deny' }, URLS, SESSION);
  const du = new URL(denied.redirect);
  assert.equal(du.searchParams.get('error'), 'access_denied');
  assert.equal(du.searchParams.get('state'), 'S');
  assert.equal(du.searchParams.get('iss'), URLS.issuer);
  const allowed = await h.oauth.decide(await pendingRequest(h, clientId), { decision: 'allow' }, URLS, SESSION);
  const au = new URL(allowed.redirect);
  assert.equal(au.searchParams.get('state'), 'S');
  assert.equal(au.searchParams.get('iss'), URLS.issuer);
  assert.deepEqual(h.audit.entries.map((e) => e.event), ['register', 'consent_deny', 'consent_allow']);
});

test('consent decision: the owner can drop mcp:write; more scopes than requested, or none, is refused', async () => {
  const h = makeOAuth();
  const clientId = await registerDcr(h.clients);
  const c = await getCode(h, clientId, { chosen: ['mcp:read'] });
  const tok = await h.oauth.token(tokenReq(clientId, c.code, c.verifier), URLS, { ip: null });
  assert.equal(tok.scope, 'mcp:read');
  const p = await h.oauth.authenticateAccess(tok.access_token, URLS);
  assert.deepEqual([...p!.scopes], ['mcp:read']);

  const readOnly = await pendingRequestScoped(h, clientId, 'mcp:read');
  await rejects(h.oauth.decide(readOnly, { decision: 'allow', scopes: ['mcp:read', 'mcp:write'] }, URLS, SESSION), 'invalid_scope', 400);
  await rejects(h.oauth.decide(readOnly, { decision: 'allow', scopes: [] }, URLS, SESSION), 'invalid_scope', 400);
});

async function pendingRequestScoped(h: ReturnType<typeof makeOAuth>, clientId: string, scope: string) {
  const { challenge } = pkce();
  const a = await h.oauth.authorize({ client_id: clientId, redirect_uri: HOSTED_REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope }, URLS);
  assert.ok(a.kind === 'redirect');
  return new URL(a.location).searchParams.get('request')!;
}

// ── token: authorization_code ────────────────────────────────────────────────

test('code exchange: returns a bearer pair, stored hashed with prefixes', async () => {
  const { h, tok } = await connected();
  assert.equal(tok.token_type, 'Bearer');
  assert.equal(tok.expires_in, 3600);
  assert.match(tok.access_token, /^ai0mcp_at_[A-Za-z0-9_-]{43}$/);
  assert.match(tok.refresh_token, /^ai0mcp_rt_[A-Za-z0-9_-]{43}$/);
  assert.equal(tok.scope, 'mcp:read mcp:write');
  assert.ok(h.store.tokens.has(sha256Hex(tok.access_token)));
  assert.ok(![...h.store.tokens.keys()].includes(tok.access_token), 'raw token is never stored');
  assert.deepEqual(h.audit.entries.map((e) => e.event).slice(-1), ['token_issued']);
});

test('code exchange: wrong verifier fails and does not burn the code', async () => {
  const h = makeOAuth();
  const clientId = await registerDcr(h.clients);
  const c = await getCode(h, clientId);
  await rejects(h.oauth.token(tokenReq(clientId, c.code, pkce().verifier), URLS, { ip: null }), 'invalid_grant', 400);
  const ok = await h.oauth.token(tokenReq(clientId, c.code, c.verifier), URLS, { ip: null });
  assert.ok(ok.access_token);
});

test('code exchange: redirect_uri and client must match the authorization request', async () => {
  const h = makeOAuth();
  const clientId = await registerDcr(h.clients);
  const other = await registerDcr(h.clients);
  const c = await getCode(h, clientId);
  await rejects(h.oauth.token(tokenReq(clientId, c.code, c.verifier, { redirect_uri: 'https://claude.com/api/mcp/auth_callback' }), URLS, { ip: null }), 'invalid_grant');
  await rejects(h.oauth.token(tokenReq(other, c.code, c.verifier), URLS, { ip: null }), 'invalid_grant');
  await rejects(h.oauth.token(tokenReq('ghost', c.code, c.verifier), URLS, { ip: null }), 'invalid_client', 401);
  await rejects(h.oauth.token(tokenReq(clientId, c.code, c.verifier, { redirect_uri: undefined }), URLS, { ip: null }), 'invalid_request');
});

test('code exchange: resource, if sent, must match', async () => {
  const h = makeOAuth();
  const clientId = await registerDcr(h.clients);
  const c = await getCode(h, clientId, { resource: URLS.resource });
  await rejects(h.oauth.token(tokenReq(clientId, c.code, c.verifier, { resource: 'https://x.example/api/mcp' }), URLS, { ip: null }), 'invalid_target');
  const ok = await h.oauth.token(tokenReq(clientId, c.code, c.verifier, { resource: `${URLS.resource}/` }), URLS, { ip: null });
  assert.ok(ok.access_token);
});

test('code exchange: an expired code is refused', async () => {
  const h = makeOAuth();
  const clientId = await registerDcr(h.clients);
  const c = await getCode(h, clientId);
  h.clock.advance(5 * 60 * 1000 + 1);
  await rejects(h.oauth.token(tokenReq(clientId, c.code, c.verifier), URLS, { ip: null }), 'invalid_grant');
});

test('code exchange: a second use is refused and revokes the grant it produced', async () => {
  const h = makeOAuth();
  const clientId = await registerDcr(h.clients);
  const c = await getCode(h, clientId);
  const first = await h.oauth.token(tokenReq(clientId, c.code, c.verifier), URLS, { ip: null });
  assert.ok(await h.oauth.authenticateAccess(first.access_token, URLS));
  await rejects(h.oauth.token(tokenReq(clientId, c.code, c.verifier), URLS, { ip: null }), 'invalid_grant');
  assert.equal(await h.oauth.authenticateAccess(first.access_token, URLS), null, 'the access token died with the grant');
  await rejects(h.oauth.token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token }, URLS, { ip: null }), 'invalid_grant');
});

test('token: grant_type and client_id are validated; unknown grant types are refused', async () => {
  const h = makeOAuth();
  await rejects(h.oauth.token({ grant_type: 'password', client_id: 'x' }, URLS, { ip: null }), 'unsupported_grant_type');
  await rejects(h.oauth.token({ grant_type: 'authorization_code' }, URLS, { ip: null }), 'invalid_request');
});

// ── refresh ──────────────────────────────────────────────────────────────────

const refreshReq = (clientId: string, refresh: string, extra: Record<string, unknown> = {}) => ({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refresh, ...extra });

test('refresh: rotates the pair; the old access token keeps working until it expires or the grant dies', async () => {
  const { h, clientId, tok } = await connected();
  h.clock.advance(1000);
  const next = await h.oauth.token(refreshReq(clientId, tok.refresh_token), URLS, { ip: null });
  assert.notEqual(next.refresh_token, tok.refresh_token);
  assert.notEqual(next.access_token, tok.access_token);
  assert.ok(await h.oauth.authenticateAccess(next.access_token, URLS));
  assert.ok(await h.oauth.authenticateAccess(tok.access_token, URLS));
});

test('refresh: a retry within 60 s revokes the successor pair and issues a fresh one', async () => {
  const { h, clientId, tok } = await connected();
  h.clock.advance(1000);
  const a = await h.oauth.token(refreshReq(clientId, tok.refresh_token), URLS, { ip: null });
  h.clock.advance(REFRESH_GRACE_MS - 5000);
  const b = await h.oauth.token(refreshReq(clientId, tok.refresh_token), URLS, { ip: null });
  assert.notEqual(b.refresh_token, a.refresh_token);
  assert.equal(await h.oauth.authenticateAccess(a.access_token, URLS), null, 'the first successor access token was revoked');
  await rejects(h.oauth.token(refreshReq(clientId, a.refresh_token), URLS, { ip: null }), 'invalid_grant');
  assert.ok(await h.oauth.authenticateAccess(b.access_token, URLS));
  // the grant survives: the fresh refresh token still rotates
  const c = await h.oauth.token(refreshReq(clientId, b.refresh_token), URLS, { ip: null });
  assert.ok(c.access_token);
});

test('refresh: reuse after the grace window revokes the whole grant, audited', async () => {
  const { h, clientId, tok } = await connected();
  h.clock.advance(1000);
  const a = await h.oauth.token(refreshReq(clientId, tok.refresh_token), URLS, { ip: null });
  h.clock.advance(REFRESH_GRACE_MS + 1000);
  await rejects(h.oauth.token(refreshReq(clientId, tok.refresh_token), URLS, { ip: '2.2.2.2' }), 'invalid_grant');
  assert.equal(await h.oauth.authenticateAccess(a.access_token, URLS), null);
  await rejects(h.oauth.token(refreshReq(clientId, a.refresh_token), URLS, { ip: null }), 'invalid_grant');
  const g = [...h.store.grants.values()][0];
  assert.equal(g.revokedReason, 'refresh_reuse');
  assert.ok(h.audit.entries.some((e) => e.event === 'refresh_reuse' && e.ip === '2.2.2.2'));
});

test('refresh: unknown, expired, wrong client, widened scope are invalid', async () => {
  const { h, clientId, tok } = await connected('mcp:read');
  const other = await registerDcr(h.clients);
  await rejects(h.oauth.token(refreshReq(clientId, 'ai0mcp_rt_nope'), URLS, { ip: null }), 'invalid_grant');
  await rejects(h.oauth.token(refreshReq(other, tok.refresh_token), URLS, { ip: null }), 'invalid_grant');
  await rejects(h.oauth.token(refreshReq(clientId, tok.access_token), URLS, { ip: null }), 'invalid_grant');
  await rejects(h.oauth.token(refreshReq(clientId, tok.refresh_token, { scope: 'mcp:read mcp:write' }), URLS, { ip: null }), 'invalid_scope');
  h.clock.advance(31 * 24 * 3600 * 1000);
  await rejects(h.oauth.token(refreshReq(clientId, tok.refresh_token), URLS, { ip: null }), 'invalid_grant');
});

test('refresh: scope may be narrowed', async () => {
  const { h, clientId, tok } = await connected();
  const n = await h.oauth.token(refreshReq(clientId, tok.refresh_token, { scope: 'mcp:read' }), URLS, { ip: null });
  assert.equal(n.scope, 'mcp:read');
  assert.deepEqual([...(await h.oauth.authenticateAccess(n.access_token, URLS))!.scopes], ['mcp:read']);
});

// ── access tokens ────────────────────────────────────────────────────────────

test('access token: expires after an hour; a different resource or a non-access token is not accepted', async () => {
  const { h, tok } = await connected();
  assert.ok(await h.oauth.authenticateAccess(tok.access_token, URLS));
  assert.equal(await h.oauth.authenticateAccess(tok.refresh_token, URLS), null);
  assert.equal(await h.oauth.authenticateAccess('TRACKING_TOKEN_VALUE', URLS), null);
  assert.equal(await h.oauth.authenticateAccess(tok.access_token, { ...URLS, resource: 'https://other.example/api/mcp' }), null);
  h.clock.advance(3600 * 1000 + 1);
  assert.equal(await h.oauth.authenticateAccess(tok.access_token, URLS), null);
});

// ── revoke ───────────────────────────────────────────────────────────────────

test('revoke: an access or a refresh token kills the whole grant; junk is ignored', async () => {
  const a = await connected();
  await a.h.oauth.revoke({ token: a.tok.access_token }, { ip: null });
  assert.equal(await a.h.oauth.authenticateAccess(a.tok.access_token, URLS), null);
  await rejects(a.h.oauth.token(refreshReq(a.clientId, a.tok.refresh_token), URLS, { ip: null }), 'invalid_grant');
  assert.ok(a.h.audit.entries.some((e) => e.event === 'revoked'));

  const b = await connected();
  await b.h.oauth.revoke({ token: b.tok.refresh_token }, { ip: null });
  assert.equal(await b.h.oauth.authenticateAccess(b.tok.access_token, URLS), null);

  await b.h.oauth.revoke({ token: 'junk' }, { ip: null });
  await b.h.oauth.revoke({}, { ip: null });
});

test('revoke: a token of another client is left alone', async () => {
  const a = await connected();
  const other = await registerDcr(a.h.clients);
  await a.h.oauth.revoke({ token: a.tok.access_token, client_id: other }, { ip: null });
  assert.ok(await a.h.oauth.authenticateAccess(a.tok.access_token, URLS));
});
