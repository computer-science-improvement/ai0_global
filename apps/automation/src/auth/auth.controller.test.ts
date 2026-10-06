import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { fakeReq, fakeRes, makeAuth, TEST_JWT_SECRET } from './testing/fakes';

function makeCtl(env: Record<string, string | undefined> = { TRACKING_TOKEN: 'secret' }) {
  const a = makeAuth(env);
  return { ...a, ctl: new AuthController(a.auth) };
}

async function loginCookie(ctl: AuthController, ua = 'UA') {
  const res = fakeRes();
  const body = await ctl.tokenLogin({ token: ' secret ' } as any, fakeReq({ ua }), res);
  return { body, cookie: res.cookies[0].value as string, res };
}

// ─── Login ──────────────────────────────────────────────────────────────────

test('token-login sets the session cookie (maxAge = idle window) and returns the identity', async () => {
  const { ctl } = makeCtl();
  const { body, res } = await loginCookie(ctl);
  assert.deepEqual(body, { tgUserId: 0, firstName: 'Operator', username: 'token' });
  assert.equal(res.cookies[0].name, 'tracking_jwt');
  assert.deepEqual(res.cookies[0].opts, { httpOnly: true, secure: false, sameSite: 'lax', path: '/', maxAge: 7 * 86_400_000 });
});

test('token-login via link opens a link session', async () => {
  const { ctl, repo } = makeCtl();
  await ctl.tokenLogin({ token: 'secret', via: 'link' } as any, fakeReq(), fakeRes());
  assert.equal([...repo.rows.values()][0].method, 'link');
});

test('a failed login returns {code, message}', async () => {
  const { ctl } = makeCtl();
  await assert.rejects(() => ctl.tokenLogin({ token: 'nope' } as any, fakeReq(), fakeRes()), (e: unknown) => {
    assert.ok(e instanceof HttpException);
    assert.deepEqual(e.getResponse(), { statusCode: 401, code: 'bad_token', message: 'Invalid token' });
    return true;
  });
});

// ─── /auth/check (FR-004) ───────────────────────────────────────────────────

test('/auth/check: 204 with a live session, no-store, no Set-Cookie even past half-life', async () => {
  const { ctl, advance } = makeCtl();
  const { cookie } = await loginCookie(ctl);
  advance(50 * 60_000);
  const res = fakeRes();
  await ctl.check(fakeReq({ cookie }), res);
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.cookies.length, 0);
  assert.ok(res.ended);
});

test('/auth/check: 401 with the reason header, empty body', async () => {
  const { ctl, svc, repo } = makeCtl();
  const none = fakeRes();
  await ctl.check(fakeReq(), none);
  assert.equal(none.statusCode, 401);
  assert.equal(none.headers['X-Auth-Reason'], 'no_credentials');

  const { cookie } = await loginCookie(ctl);
  await svc.revoke([...repo.rows.keys()][0], 'revoked');
  const revoked = fakeRes();
  await ctl.check(fakeReq({ cookie }), revoked);
  assert.equal(revoked.statusCode, 401);
  assert.equal(revoked.headers['X-Auth-Reason'], 'session_revoked');
});

test('/auth/check on a DB error: 204 while the JWT is unexpired, else 503 (never 401)', async () => {
  const { ctl, repo, advance } = makeCtl();
  const { cookie } = await loginCookie(ctl);
  repo.failReads = true;
  advance(5 * 60_000);
  const up = fakeRes();
  await ctl.check(fakeReq({ cookie }), up);
  assert.equal(up.statusCode, 204);
  advance(2 * 3_600_000);
  const down = fakeRes();
  await ctl.check(fakeReq({ cookie }), down);
  assert.equal(down.statusCode, 503);
});

test('/auth/check performs no writes', async () => {
  const { ctl, repo, events, advance } = makeCtl();
  const { cookie } = await loginCookie(ctl);
  const before = events.events.length;
  advance(30 * 60_000);
  await ctl.check(fakeReq({ cookie }), fakeRes());
  assert.equal(repo.touches, 0);
  assert.equal(events.events.length, before);
});

// ─── /auth/me (FR-005) ──────────────────────────────────────────────────────

test('/auth/me accepts Bearer', async () => {
  const { ctl } = makeCtl();
  const me = await ctl.me(fakeReq({ bearer: 'secret' }), fakeRes());
  assert.deepEqual(me, { tgUserId: 0, firstName: 'Operator', username: 'token', method: 'bearer' });
});

test('/auth/me with a session: method, sessionId, expiresAt; renews past half-life', async () => {
  const { ctl, repo, advance } = makeCtl();
  const { cookie } = await loginCookie(ctl);
  advance(40 * 60_000);
  const res = fakeRes();
  const me: any = await ctl.me(fakeReq({ cookie }), res);
  assert.equal(me.method, 'session');
  assert.equal(me.sessionId, [...repo.rows.keys()][0]);
  assert.ok(!Number.isNaN(Date.parse(me.expiresAt)));
  assert.equal(res.cookies.length, 1);
});

test('/auth/me without a session → null; a dead cookie is cleared, explained and audited once', async () => {
  const { ctl, events } = makeCtl();
  assert.equal(await ctl.me(fakeReq(), fakeRes()), null);
  const legacy = await new JwtService({ secret: TEST_JWT_SECRET }).signAsync({ sub: 0, firstName: 'Operator' });
  const res = fakeRes();
  assert.equal(await ctl.me(fakeReq({ cookie: legacy }), res), null);
  assert.equal(res.headers['X-Auth-Reason'], 'session_legacy');
  assert.equal(res.cleared[0].name, 'tracking_jwt');
  assert.deepEqual(events.events.map((e) => [e.kind, e.code]), [['expired', 'session_legacy']]);
});

test('/auth/me returns the dev identity only when the backend bypass applies', async () => {
  const dev = makeCtl({ ALLOW_NO_AUTH: 'true', NODE_ENV: 'development' });
  assert.deepEqual(await dev.ctl.me(fakeReq(), fakeRes()), { tgUserId: 0, firstName: 'Dev', username: 'dev', method: 'dev' });
  const prod = makeCtl({ ALLOW_NO_AUTH: 'true', NODE_ENV: 'production' });
  assert.equal(await prod.ctl.me(fakeReq(), fakeRes()), null);
});

// ─── Logout, sessions, events (FR-010, FR-014) ──────────────────────────────

test('logout revokes the session and clears the cookie', async () => {
  const { ctl, repo } = makeCtl();
  const { cookie } = await loginCookie(ctl);
  const res = fakeRes();
  assert.deepEqual(await ctl.logout(fakeReq({ cookie }), res), { ok: true });
  assert.equal([...repo.rows.values()][0].revokedReason, 'logout');
  assert.deepEqual(res.cleared[0], { name: 'tracking_jwt', opts: { httpOnly: true, secure: false, sameSite: 'lax', path: '/' } });
});

test('sessions endpoints: list with current, revoke current clears the cookie, revoke-all others keeps it', async () => {
  const { ctl, auth } = makeCtl();
  const a = await loginCookie(ctl);
  await loginCookie(ctl);
  const c = await loginCookie(ctl);
  const req: any = fakeReq({ cookie: a.cookie });
  const r = await auth.authenticate(req);
  assert.ok(r.ok);
  req.auth = r;

  const list = await ctl.sessions(req);
  assert.equal(list.length, 3);
  assert.equal(list.filter((s) => s.current).length, 1);

  const other = fakeRes();
  const cId = list.find((s) => !s.current && s.id)!.id;
  assert.deepEqual(await ctl.revokeSession(cId, req, other), { ok: true, revoked: true, current: false });
  assert.equal(other.cleared.length, 0);

  const all = fakeRes();
  assert.deepEqual(await ctl.revokeAll({}, req, all), { ok: true, revoked: 1, current: false });
  assert.equal(all.cleared.length, 0);
  assert.equal((await ctl.sessions(req)).length, 1);

  const self = fakeRes();
  assert.deepEqual(await ctl.revokeSession(r.ok ? r.sid! : '', req, self), { ok: true, revoked: true, current: true });
  assert.equal(self.cleared.length, 1);
  void c;
});

test('events endpoint clamps the limit', async () => {
  const { ctl, events } = makeCtl();
  for (let i = 0; i < 3; i++) await loginCookie(ctl);
  assert.equal((await ctl.events('2')).length, 2);
  assert.equal((await ctl.events('abc')).length, 3);
  events.events.push(...Array.from({ length: 300 }, () => ({ kind: 'login_failed' })));
  assert.equal((await ctl.events('999')).length, 200);
});
