// Spec 028 FR-008 / FR-009 through AuthService and the controller: limiter
// codes, Retry-After, lockout and burst alerts, the new-device ping, audit rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { loginErrorCode } from './auth.service';
import { fakeReq, fakeRes, makeAuth } from './testing/fakes';

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/128.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1';
const client = (ip: string, userAgent = MAC) => ({ ip, userAgent });

test('rate_limited: the 11th attempt in a minute gets 429 {code, message, retryAfterSec} and a Retry-After header', async () => {
  const { auth } = makeAuth({ TRACKING_TOKEN: 'secret' });
  const ctl = new AuthController(auth);
  for (let i = 0; i < 10; i++) await ctl.tokenLogin({ token: 'secret' } as any, fakeReq({ ip: '7.7.7.7' }), fakeRes());
  const res = fakeRes();
  await assert.rejects(() => ctl.tokenLogin({ token: 'secret' } as any, fakeReq({ ip: '7.7.7.7' }), res), (e: unknown) => {
    assert.ok(e instanceof HttpException);
    assert.equal(e.getStatus(), 429);
    const body = e.getResponse() as any;
    assert.equal(body.code, 'rate_limited');
    assert.ok(body.retryAfterSec >= 1 && body.retryAfterSec <= 60);
    assert.equal(res.headers['Retry-After'], String(body.retryAfterSec));
    return true;
  });
});

test('the window is shared by both login routes', async () => {
  const { auth } = makeAuth({ TRACKING_TOKEN: 'secret' });
  const ctl = new AuthController(auth);
  for (let i = 0; i < 10; i++) await ctl.tokenLogin({ token: 'secret' } as any, fakeReq({ ip: '7.7.7.8' }), fakeRes());
  await assert.rejects(
    () => ctl.login({ id: 1, first_name: 'x', auth_date: 0, hash: 'x' } as any, fakeReq({ ip: '7.7.7.8' }), fakeRes()),
    (e: unknown) => loginErrorCode(e) === 'rate_limited');
});

test('20 failures lock the IP out (locked_out, audited once) while another IP still signs in', async () => {
  const { auth, events, advance } = makeAuth({ TRACKING_TOKEN: 'secret' });
  for (let i = 0; i < 20; i++) {
    await assert.rejects(() => auth.login('token', 'wrong', client('6.6.6.6')), (e) => loginErrorCode(e) === 'bad_token');
    advance(10_000); // stay under 10/min
  }
  await assert.rejects(() => auth.login('token', 'secret', client('6.6.6.6')), (e: unknown) => {
    assert.equal(loginErrorCode(e), 'locked_out');
    assert.equal((e as HttpException).getStatus(), 429);
    return true;
  });
  await assert.rejects(() => auth.login('token', 'secret', client('6.6.6.6')));
  assert.ok((await auth.login('token', 'secret', client('6.6.6.7'))).token);
  assert.equal(events.events.filter((e) => e.kind === 'locked_out').length, 1);
  assert.equal(events.events.filter((e) => e.kind === 'login_failed').length, 20);
});

test('rate_limited rows are written at most once a minute per IP', async () => {
  const { auth, events } = makeAuth({ TRACKING_TOKEN: 'secret' }, { limit: 1 });
  await auth.login('token', 'secret', client('8.8.8.8'));
  for (let i = 0; i < 5; i++) await assert.rejects(() => auth.login('token', 'secret', client('8.8.8.8')));
  assert.equal(events.events.filter((e) => e.kind === 'rate_limited').length, 1);
});

test('global burst: 50 failures across IPs alert the owner once, nobody is locked', async () => {
  const { auth, alerts } = makeAuth({ TRACKING_TOKEN: 'secret' });
  for (let i = 0; i < 55; i++) await assert.rejects(() => auth.login('token', 'wrong', client(`10.9.${i}.1`)));
  const burst = alerts.filter((a) => /50 failed sign-in attempts/.test(a));
  assert.equal(burst.length, 1);
  assert.ok((await auth.login('token', 'secret', client('10.9.0.1'))).token);
});

test('new device: the first login pings the owner; the same network + browser does not; a new browser does', async () => {
  // The fake recentLogins reads the fake audit: successful logins of other sessions.
  const { auth, alerts } = makeAuth({ TRACKING_TOKEN: 'secret' });

  await auth.login('token', 'secret', client('91.1.2.3'));
  await auth.lastDeviceCheck;
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /New sign-in/);
  assert.match(alerts[0], /91\.1\.2\.3/);
  assert.match(alerts[0], /Chrome · macOS/);
  assert.doesNotMatch(alerts[0], /secret/);

  await auth.login('token', 'secret', client('91.1.2.200'));   // same /24, same browser
  await auth.lastDeviceCheck;
  assert.equal(alerts.length, 1);

  await auth.login('token', 'secret', client('91.1.2.3', IPHONE)); // same network, new device family
  await auth.lastDeviceCheck;
  assert.equal(alerts.length, 2);

  await auth.login('token', 'secret', client('92.1.2.3'));     // new network
  await auth.lastDeviceCheck;
  assert.equal(alerts.length, 3);
});

test('a failing alert or device check never breaks the login', async () => {
  const { auth, events } = makeAuth({ TRACKING_TOKEN: 'secret' });
  events.recentLogins = async () => { throw new Error('db down'); };
  assert.ok((await auth.login('token', 'secret', client('1.1.1.1'))).token);
  await auth.lastDeviceCheck;
});

test('Redis down: logins are still limited in memory', async () => {
  const { auth, redis } = makeAuth({ TRACKING_TOKEN: 'secret' }, { limit: 2, redisTimeoutMs: 20 });
  redis.mode = 'throw';
  await auth.login('token', 'secret', client('3.3.3.3'));
  await auth.login('token', 'secret', client('3.3.3.3'));
  await assert.rejects(() => auth.login('token', 'secret', client('3.3.3.3')), (e) => loginErrorCode(e) === 'rate_limited');
});
