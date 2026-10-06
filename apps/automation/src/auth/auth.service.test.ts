import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'crypto';
import { ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { loginErrorCode } from './auth.service';
import { TelegramLoginDto } from './telegram-login.dto';
import { fakeReq, makeAuth, TEST_JWT_SECRET } from './testing/fakes';

const BOT_TOKEN = '123:bot-token';
const CLIENT = { ip: '1.2.3.4', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/128.0 Safari/537.36' };
const MIN = 60_000;

/** Build a Telegram login payload with a valid widget signature. */
function signedLogin(id: number, ageSec = 0): TelegramLoginDto {
  const fields: Omit<TelegramLoginDto, 'hash'> = {
    id, first_name: 'Owner', username: 'owner', auth_date: Math.floor(Date.now() / 1000) - ageSec,
  };
  const dataCheckString = Object.keys(fields).sort()
    .map((k) => `${k}=${(fields as any)[k]}`).join('\n');
  const secret = createHash('sha256').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return { ...fields, hash };
}

/** Assert a login rejection carries the FR-007 code, the HTTP status, and no env var name. */
async function rejectsWith(p: Promise<unknown>, code: string, status: number) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof HttpException);
    assert.equal(e.getStatus(), status);
    assert.equal(loginErrorCode(e), code);
    assert.doesNotMatch(e.message, /[A-Z]{2,}_[A-Z_]+/, 'no env var names in messages');
    return true;
  });
}

// ─── Login: Telegram (FR-007) ───────────────────────────────────────────────

test('telegram login FAILS CLOSED when TRACKING_ALLOWED_TG_USER_IDS is empty / unset / junk', async () => {
  for (const allow of ['', undefined, ' , abc,']) {
    const { auth } = makeAuth({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, TRACKING_ALLOWED_TG_USER_IDS: allow });
    await assert.rejects(() => auth.login('telegram', signedLogin(42), CLIENT), ForbiddenException);
    await rejectsWith(auth.login('telegram', signedLogin(42), CLIENT), 'telegram_login_disabled', 403);
  }
});

test('telegram login without a bot token: telegram_login_disabled', async () => {
  const { auth } = makeAuth({ TRACKING_ALLOWED_TG_USER_IDS: '42' });
  await rejectsWith(auth.login('telegram', signedLogin(42), CLIENT), 'telegram_login_disabled', 403);
});

test('telegram login accepts an allowlisted user, opens a session and audits login_ok', async () => {
  const { auth, repo, events } = makeAuth({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, TRACKING_ALLOWED_TG_USER_IDS: '7, 42' });
  const { token, session, identity } = await auth.login('telegram', signedLogin(42), CLIENT);
  assert.equal(identity.sub, 42);
  assert.ok(token);
  const row = repo.rows.get(session.id)!;
  assert.equal(row.method, 'telegram');
  assert.equal(row.subjectId, 42);
  assert.equal(row.ip, '1.2.3.4');
  assert.deepEqual(events.events.map((e) => [e.kind, e.method, e.sessionId]), [['login_ok', 'telegram', session.id]]);
});

test('telegram login rejects a user outside the allowlist: not_allowlisted, audited', async () => {
  const { auth, events, repo } = makeAuth({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, TRACKING_ALLOWED_TG_USER_IDS: '7' });
  await rejectsWith(auth.login('telegram', signedLogin(42), CLIENT), 'not_allowlisted', 403);
  assert.equal(repo.rows.size, 0);
  assert.deepEqual(events.events.map((e) => [e.kind, e.code]), [['login_failed', 'not_allowlisted']]);
});

test('telegram login rejects a tampered signature: bad_signature', async () => {
  const { auth } = makeAuth({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, TRACKING_ALLOWED_TG_USER_IDS: '42' });
  await assert.rejects(() => auth.login('telegram', { ...signedLogin(42), hash: 'a'.repeat(64) }, CLIENT), UnauthorizedException);
  await rejectsWith(auth.login('telegram', { ...signedLogin(42), hash: 'a'.repeat(64) }, CLIENT), 'bad_signature', 401);
});

test('telegram login rejects a payload older than a day: payload_expired', async () => {
  const { auth } = makeAuth({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, TRACKING_ALLOWED_TG_USER_IDS: '42' });
  await rejectsWith(auth.login('telegram', signedLogin(42, 86_401), CLIENT), 'payload_expired', 401);
});

// ─── Login: token (FR-007) ──────────────────────────────────────────────────

test('token login: accepts the exact TRACKING_TOKEN, rejects anything else with bad_token', async () => {
  const { auth } = makeAuth({ TRACKING_TOKEN: 'secret' });
  assert.ok((await auth.login('token', 'secret', CLIENT)).token);
  await rejectsWith(auth.login('token', 'secreT', CLIENT), 'bad_token', 401);
  await rejectsWith(auth.login('token', 'secret-longer', CLIENT), 'bad_token', 401);
});

test('token login with TRACKING_TOKEN unset: token_login_disabled', async () => {
  const { auth } = makeAuth({});
  await rejectsWith(auth.login('token', 'anything', CLIENT), 'token_login_disabled', 403);
});

test('link login is audited as method link; the token never reaches the audit or the session', async () => {
  const { auth, events, repo } = makeAuth({ TRACKING_TOKEN: 'super-secret-value' });
  const { session } = await auth.login('link', 'super-secret-value', CLIENT);
  await auth.login('token', 'super-secret-wrong', CLIENT).catch(() => undefined);
  assert.equal(repo.rows.get(session.id)!.method, 'link');
  assert.equal(events.events[0].method, 'link');
  const dump = JSON.stringify([...repo.rows.values(), ...events.events]);
  assert.doesNotMatch(dump, /super-secret/);
});

// ─── authenticate() (FR-003) ────────────────────────────────────────────────

test('authenticate: Bearer TRACKING_TOKEN → bearer, no session row', async () => {
  const { auth, repo } = makeAuth({ TRACKING_TOKEN: 'secret' });
  const r = await auth.authenticate(fakeReq({ bearer: 'secret' }));
  assert.ok(r.ok && r.method === 'bearer' && !r.sid);
  assert.equal(repo.rows.size, 0);
});

test('authenticate: Bearer wins over a dead cookie; a wrong Bearer alone is bad_token', async () => {
  const { auth } = makeAuth({ TRACKING_TOKEN: 'secret' });
  const legacy = await new JwtService({ secret: TEST_JWT_SECRET }).signAsync({ sub: 0, firstName: 'x' });
  assert.equal((await auth.authenticate(fakeReq({ bearer: 'secret', cookie: legacy }))).ok, true);
  assert.deepEqual(await auth.authenticate(fakeReq({ bearer: 'wrong' })), { ok: false, code: 'bad_token' });
});

test('authenticate: session cookie → session with sid and identity', async () => {
  const { auth } = makeAuth({ TRACKING_TOKEN: 'secret' });
  const { token, session } = await auth.login('token', 'secret', CLIENT);
  const r = await auth.authenticate(fakeReq({ cookie: token }));
  assert.ok(r.ok && r.method === 'session');
  assert.ok(r.ok && r.sid === session.id && r.identity.firstName === 'Operator' && r.expiresAt);
});

test('authenticate: 401 codes — no_credentials, session_revoked, session_legacy, session_expired', async () => {
  const { auth, svc, advance } = makeAuth({ TRACKING_TOKEN: 'secret' });
  assert.deepEqual(await auth.authenticate(fakeReq()), { ok: false, code: 'no_credentials' });

  const a = await auth.login('token', 'secret', CLIENT);
  await svc.revoke(a.session.id, 'revoked');
  assert.deepEqual(await auth.authenticate(fakeReq({ cookie: a.token })), { ok: false, code: 'session_revoked', sid: a.session.id });

  const legacy = await new JwtService({ secret: TEST_JWT_SECRET }).signAsync({ sub: 0, firstName: 'Operator' }, { expiresIn: '30d' });
  assert.deepEqual(await auth.authenticate(fakeReq({ cookie: legacy })), { ok: false, code: 'session_legacy' });

  const b = await auth.login('token', 'secret', CLIENT);
  advance(8 * 86_400_000);
  assert.deepEqual(await auth.authenticate(fakeReq({ cookie: b.token })), { ok: false, code: 'session_expired', sid: b.session.id });
});

test('authenticate: dev bypass only with ALLOW_NO_AUTH, outside production, no TRACKING_TOKEN, no credentials', async () => {
  const dev = { ALLOW_NO_AUTH: 'true', NODE_ENV: 'development' };
  const ok = await makeAuth(dev).auth.authenticate(fakeReq());
  assert.ok(ok.ok && ok.method === 'dev' && ok.identity.firstName === 'Dev');
  assert.deepEqual(await makeAuth({ ...dev, NODE_ENV: 'production' }).auth.authenticate(fakeReq()), { ok: false, code: 'no_credentials' });
  assert.deepEqual(await makeAuth({ ...dev, TRACKING_TOKEN: 'secret' }).auth.authenticate(fakeReq()), { ok: false, code: 'no_credentials' });
  assert.deepEqual(await makeAuth({}).auth.authenticate(fakeReq()), { ok: false, code: 'no_credentials' });
  // A presented (dead) cookie is never bypassed.
  const r = await makeAuth(dev).auth.authenticate(fakeReq({ cookie: 'garbage' }));
  assert.deepEqual(r, { ok: false, code: 'session_expired' });
});

test('authenticate: past half-life → renewToken; readOnly never renews', async () => {
  const { auth, advance } = makeAuth({ TRACKING_TOKEN: 'secret' });
  const { token } = await auth.login('token', 'secret', CLIENT);
  advance(40 * MIN);
  const ro = await auth.authenticate(fakeReq({ cookie: token }), { readOnly: true });
  assert.ok(ro.ok && !ro.renewToken);
  const rw = await auth.authenticate(fakeReq({ cookie: token }));
  assert.ok(rw.ok && rw.renewToken);
});

test('authenticate: DB outage — unexpired JWT is accepted (degraded), expired JWT is unavailable', async () => {
  const { auth, repo, advance } = makeAuth({ TRACKING_TOKEN: 'secret' });
  const { token, session } = await auth.login('token', 'secret', CLIENT);
  repo.failReads = true;
  advance(10 * MIN);
  const r = await auth.authenticate(fakeReq({ cookie: token }), { readOnly: true });
  assert.ok(r.ok && r.degraded && r.sid === session.id);
  advance(2 * 3_600_000);
  assert.deepEqual(await auth.authenticate(fakeReq({ cookie: token })), { ok: false, code: 'unavailable' });
});

// ─── Logout and session management (FR-010, FR-014) ─────────────────────────

test('logout revokes the session (reason logout) and audits it; the cookie then reads session_revoked', async () => {
  const { auth, repo, events } = makeAuth({ TRACKING_TOKEN: 'secret' });
  const { token, session } = await auth.login('token', 'secret', CLIENT);
  await auth.logout(fakeReq({ cookie: token }), CLIENT);
  assert.equal(repo.rows.get(session.id)!.revokedReason, 'logout');
  assert.equal(events.events.at(-1).kind, 'logout');
  assert.equal((await auth.authenticate(fakeReq({ cookie: token }))).ok, false);
  await auth.logout(fakeReq(), CLIENT); // no cookie: a no-op
  await auth.logout(fakeReq({ cookie: token }), CLIENT); // already revoked: no second event
  assert.equal(events.events.filter((e) => e.kind === 'logout').length, 1);
});

test('listSessions marks the current one and shows a device family, not the raw UA', async () => {
  const { auth } = makeAuth({ TRACKING_TOKEN: 'secret' });
  const a = await auth.login('token', 'secret', CLIENT);
  await auth.login('token', 'secret', { ip: '5.6.7.8', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1' });
  const list = await auth.listSessions(a.session.id);
  assert.equal(list.length, 2);
  const cur = list.find((s) => s.current)!;
  assert.equal(cur.id, a.session.id);
  assert.equal(cur.device, 'Chrome · macOS');
  assert.equal(list.find((s) => !s.current)!.device, 'Safari · iOS');
  assert.ok(cur.expiresAt instanceof Date);
});

test('revokeSession: another session vs the current one; audited as revoked', async () => {
  const { auth, events } = makeAuth({ TRACKING_TOKEN: 'secret' });
  const a = await auth.login('token', 'secret', CLIENT);
  const b = await auth.login('token', 'secret', CLIENT);
  assert.deepEqual(await auth.revokeSession(b.session.id, a.session.id, CLIENT), { revoked: true, current: false });
  assert.deepEqual(await auth.revokeSession(a.session.id, a.session.id, CLIENT), { revoked: true, current: true });
  assert.deepEqual(await auth.revokeSession(a.session.id, a.session.id, CLIENT), { revoked: false, current: true });
  assert.equal(events.events.filter((e) => e.kind === 'revoked').length, 2);
});

test('revokeAll: others only, everything with includeCurrent, everything for a Bearer caller', async () => {
  const { auth, events } = makeAuth({ TRACKING_TOKEN: 'secret' });
  const a = await auth.login('token', 'secret', CLIENT);
  await auth.login('token', 'secret', CLIENT);
  await auth.login('token', 'secret', CLIENT);
  assert.deepEqual(await auth.revokeAll(a.session.id, false, CLIENT), { revoked: 2, current: false });
  assert.equal((await auth.authenticate(fakeReq({ cookie: a.token }))).ok, true);
  assert.deepEqual(await auth.revokeAll(a.session.id, true, CLIENT), { revoked: 1, current: true });
  assert.equal((await auth.authenticate(fakeReq({ cookie: a.token }))).ok, false);
  await auth.login('token', 'secret', CLIENT);
  assert.deepEqual(await auth.revokeAll(undefined, false, CLIENT), { revoked: 1, current: false });
  assert.equal(events.events.filter((e) => e.kind === 'revoke_all').length, 3);
  assert.equal((await auth.authenticate(fakeReq({ bearer: 'secret' }))).ok, true, 'Bearer is unaffected');
});

test('recentEvents maps rows; an audit write failure never breaks the login', async () => {
  const { auth, events } = makeAuth({ TRACKING_TOKEN: 'secret' });
  await auth.login('token', 'secret', CLIENT);
  const [e] = await auth.recentEvents(50);
  assert.equal(e.kind, 'login_ok');
  assert.equal(e.device, 'Chrome · macOS');
  events.record = async () => { throw new Error('db down'); };
  assert.ok((await auth.login('token', 'secret', CLIENT)).token);
});
