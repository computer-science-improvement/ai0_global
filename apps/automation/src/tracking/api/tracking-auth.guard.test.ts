import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { TrackingAuthGuard } from './tracking-auth.guard';
import { fakeReq, fakeRes, makeAuth } from '../../auth/testing/fakes';

const CLIENT = { ip: '1.2.3.4', userAgent: 'UA' };

function ctxFor(req: any, res = fakeRes()) {
  return { ctx: { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as any, req, res };
}

function makeGuard(env: Record<string, string | undefined>) {
  const a = makeAuth(env);
  return { ...a, guard: new TrackingAuthGuard(a.auth) };
}

function bodyOf(e: unknown): any {
  assert.ok(e instanceof HttpException);
  return { status: e.getStatus(), ...(e.getResponse() as object) };
}

test('accepts a matching bearer TRACKING_TOKEN', async () => {
  const { guard } = makeGuard({ TRACKING_TOKEN: 'secret' });
  const { ctx, req } = ctxFor(fakeReq({ bearer: 'secret' }));
  assert.equal(await guard.canActivate(ctx), true);
  assert.equal(req.auth.method, 'bearer');
});

test('accepts a valid session cookie and attaches req.user and req.auth', async () => {
  const { guard, auth } = makeGuard({ TRACKING_TOKEN: 'secret' });
  const { token, session } = await auth.login('token', 'secret', CLIENT);
  const { ctx, req, res } = ctxFor(fakeReq({ cookie: token }));
  assert.equal(await guard.canActivate(ctx), true);
  assert.deepEqual(req.user, { sub: 0, firstName: 'Operator', username: 'token' });
  assert.equal(req.auth.sid, session.id);
  assert.equal(res.cookies.length, 0, 'fresh token: no renewal');
});

test('sliding renewal: a token past half-life gets a fresh cookie with maxAge = idle window', async () => {
  const { guard, auth, advance } = makeGuard({ TRACKING_TOKEN: 'secret', NODE_ENV: 'production' });
  const { token } = await auth.login('token', 'secret', CLIENT);
  advance(45 * 60_000);
  const { ctx, res } = ctxFor(fakeReq({ cookie: token }));
  assert.equal(await guard.canActivate(ctx), true);
  assert.equal(res.cookies.length, 1);
  const c = res.cookies[0];
  assert.equal(c.name, 'tracking_jwt');
  assert.notEqual(c.value, token);
  assert.deepEqual(c.opts, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 7 * 86_400_000 });
});

test('FAILS CLOSED: no credentials and no ALLOW_NO_AUTH → 401 {code: no_credentials}', async () => {
  const { guard } = makeGuard({});
  const { ctx } = ctxFor(fakeReq());
  await assert.rejects(() => guard.canActivate(ctx), /Invalid or missing credentials/);
  await assert.rejects(() => guard.canActivate(ctx), (e) => bodyOf(e).status === 401 && bodyOf(e).code === 'no_credentials');
});

test('a revoked session → 401 {code: session_revoked}', async () => {
  const { guard, auth, svc } = makeGuard({ TRACKING_TOKEN: 'secret' });
  const { token, session } = await auth.login('token', 'secret', CLIENT);
  await svc.revoke(session.id, 'revoked');
  await assert.rejects(() => guard.canActivate(ctxFor(fakeReq({ cookie: token })).ctx), (e) => bodyOf(e).code === 'session_revoked');
});

test('explicit ALLOW_NO_AUTH=true bypass works in dev when no creds presented', async () => {
  const { guard } = makeGuard({ ALLOW_NO_AUTH: 'true', NODE_ENV: 'development' });
  const { ctx, req } = ctxFor(fakeReq());
  assert.equal(await guard.canActivate(ctx), true);
  assert.equal(req.auth.method, 'dev');
});

test('ALLOW_NO_AUTH is ignored in production', async () => {
  const { guard } = makeGuard({ ALLOW_NO_AUTH: 'true', NODE_ENV: 'production' });
  await assert.rejects(() => guard.canActivate(ctxFor(fakeReq()).ctx), /Invalid or missing credentials/);
});

test('ALLOW_NO_AUTH does not bypass an invalid bearer token', async () => {
  const { guard } = makeGuard({ TRACKING_TOKEN: 'secret', ALLOW_NO_AUTH: 'true', NODE_ENV: 'development' });
  await assert.rejects(() => guard.canActivate(ctxFor(fakeReq({ bearer: 'wrong' })).ctx), (e) => bodyOf(e).code === 'bad_token');
});

test('session DB down with an expired JWT → 503, not 401 (an outage is not a logout)', async () => {
  const { guard, auth, repo, advance } = makeGuard({ TRACKING_TOKEN: 'secret' });
  const { token } = await auth.login('token', 'secret', CLIENT);
  repo.failReads = true;
  advance(2 * 3_600_000);
  await assert.rejects(() => guard.canActivate(ctxFor(fakeReq({ cookie: token })).ctx), (e) => bodyOf(e).status === 503);
});
