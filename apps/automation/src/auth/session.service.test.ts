import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { envNumber, readSessionSettings, LAST_SEEN_THROTTLE_MS } from './session.service';
import type { NewSession } from './auth-sessions.repository';
import { makeSessions, TEST_JWT_SECRET } from './testing/fakes';

const MIN = 60_000;
const DAY = 86_400_000;

const LOGIN: NewSession = { method: 'token', subjectId: 0, firstName: 'Operator', username: 'token', ip: '1.2.3.4', userAgent: 'UA' };

test('envNumber: empty, junk and non-positive values mean the default', () => {
  const env = (m: Record<string, string>) => (k: string) => m[k];
  assert.equal(envNumber(env({ X: '' }), 'X', 7), 7);
  assert.equal(envNumber(env({ X: '  ' }), 'X', 7), 7);
  assert.equal(envNumber(env({ X: 'abc' }), 'X', 7), 7);
  assert.equal(envNumber(env({ X: '0' }), 'X', 7), 7);
  assert.equal(envNumber(env({ X: '-3' }), 'X', 7), 7);
  assert.equal(envNumber(env({ X: '30' }), 'X', 7), 30);
  assert.deepEqual(readSessionSettings(env({})), { accessTtlMin: 60, idleTtlDays: 7, absoluteTtlDays: 30, eventsRetentionDays: 180 });
});

test('issue: inserts a row and signs {sub, sid, method, firstName, username, v: 2} with exp = access TTL', async () => {
  const { svc, repo, jwt } = makeSessions();
  const { token, session } = await svc.issue(LOGIN);
  assert.equal(repo.rows.size, 1);
  const c = await jwt.verifyAsync(token);
  assert.equal(c.sid, session.id);
  assert.equal(c.sub, 0);
  assert.equal(c.method, 'token');
  assert.equal(c.firstName, 'Operator');
  assert.equal(c.username, 'token');
  assert.equal(c.v, 2);
  assert.equal(c.exp - c.iat, 3600);
  assert.equal(svc.cookieMaxAgeMs, 7 * DAY);
});

test('issue honours AUTH_ACCESS_TTL_MIN', async () => {
  const { svc, jwt } = makeSessions({ AUTH_ACCESS_TTL_MIN: '15' });
  const c = await jwt.verifyAsync((await svc.issue(LOGIN)).token);
  assert.equal(c.exp - c.iat, 900);
});

test('verify: a fresh token is valid, served from the cache, not renewed', async () => {
  const { svc, repo } = makeSessions();
  const { token, session } = await svc.issue(LOGIN);
  const r = await svc.verify(token);
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.session.id === session.id && !r.renewToken);
  assert.equal(repo.finds, 0);
});

test('verify: past half-life re-reads the DB and renews the token', async () => {
  const { svc, repo, jwt, advance } = makeSessions();
  const { token } = await svc.issue(LOGIN);
  advance(31 * MIN);
  const r = await svc.verify(token);
  assert.ok(r.ok && r.renewToken);
  assert.equal(repo.finds, 1);
  const c = await jwt.verifyAsync(r.ok ? r.renewToken! : '');
  assert.equal(c.v, 2);
});

test('verify: an expired JWT within the idle window is renewed after a DB check', async () => {
  const { svc, repo, advance } = makeSessions();
  const { token } = await svc.issue(LOGIN);
  advance(3 * 3_600_000); // JWT (60 min) long expired; idle window is 7 days
  const r = await svc.verify(token);
  assert.ok(r.ok && r.renewToken);
  assert.equal(repo.finds, 1);
});

test('verify: idle expiry — not seen for longer than the idle window', async () => {
  const { svc, advance } = makeSessions();
  const { token, session } = await svc.issue(LOGIN);
  advance(7 * DAY + MIN);
  assert.deepEqual(await svc.verify(token), { ok: false, code: 'session_expired', sid: session.id });
});

test('verify: absolute cap — 30 days after login even when used daily', async () => {
  const { svc, repo, advance } = makeSessions();
  const { token: first, session } = await svc.issue(LOGIN);
  let token = first;
  for (let d = 0; d < 29; d++) {
    advance(DAY);
    const r = await svc.verify(token);
    assert.ok(r.ok, `day ${d + 1} still valid`);
    if (r.ok && r.renewToken) token = r.renewToken;
  }
  assert.ok(repo.rows.get(session.id)!.lastSeenAt.getTime() > Date.now() + 28 * DAY);
  advance(DAY + MIN);
  assert.deepEqual(await svc.verify(token), { ok: false, code: 'session_expired', sid: session.id });
});

test('verify: revoked session; revoke invalidates the cache synchronously', async () => {
  const { svc, repo } = makeSessions();
  const { token, session } = await svc.issue(LOGIN);
  assert.equal((await svc.verify(token)).ok, true);      // cached
  assert.equal(await svc.revoke(session.id, 'revoked'), true);
  assert.deepEqual(await svc.verify(token), { ok: false, code: 'session_revoked', sid: session.id });
  assert.equal(repo.finds, 1);                             // the cache did not answer
});

test('revokeAll keeps the excluded session and drops every cache entry', async () => {
  const { svc } = makeSessions();
  const a = await svc.issue(LOGIN);
  const b = await svc.issue(LOGIN);
  const c = await svc.issue(LOGIN);
  const ids = await svc.revokeAll(a.session.id, 'revoke_all');
  assert.deepEqual(ids.sort(), [b.session.id, c.session.id].sort());
  assert.equal((await svc.verify(a.token)).ok, true);
  assert.deepEqual(await svc.verify(b.token), { ok: false, code: 'session_revoked', sid: b.session.id });
  assert.deepEqual(await svc.verify(c.token), { ok: false, code: 'session_revoked', sid: c.session.id });
});

test('verify: a JWT without sid is session_legacy; a bad signature is session_expired', async () => {
  const { svc } = makeSessions();
  const legacy = await new JwtService({ secret: TEST_JWT_SECRET }).signAsync({ sub: 0, firstName: 'Operator' }, { expiresIn: '30d' });
  assert.deepEqual(await svc.verify(legacy), { ok: false, code: 'session_legacy' });
  const forged = await new JwtService({ secret: 'other' }).signAsync({ sub: 0, sid: randomUUID(), v: 2 }, { expiresIn: 60 });
  assert.deepEqual(await svc.verify(forged), { ok: false, code: 'session_expired' });
  assert.deepEqual(await svc.verify('not-a-jwt'), { ok: false, code: 'session_expired' });
});

test('verify: an unknown sid (purged row) is session_expired', async () => {
  const { svc, repo, advance } = makeSessions();
  const { token, session } = await svc.issue(LOGIN);
  repo.rows.delete(session.id);
  advance(31 * MIN); // force a DB read
  assert.deepEqual(await svc.verify(token), { ok: false, code: 'session_expired', sid: session.id });
});

test('last_seen is written at most every 5 minutes', async () => {
  const { svc, repo, advance } = makeSessions();
  const { token } = await svc.issue(LOGIN);
  await svc.verify(token);
  advance(MIN);
  await svc.verify(token);
  assert.equal(repo.touches, 0);
  advance(LAST_SEEN_THROTTLE_MS);
  await svc.verify(token);
  await svc.verify(token);
  assert.equal(repo.touches, 1);
});

test('readOnly verify: no touch, no renewal, the DB only on a cache miss', async () => {
  const { svc, repo, advance } = makeSessions();
  const { token } = await svc.issue(LOGIN);
  advance(50 * MIN); // past half-life; the cache entry from issue() is stale
  const r = await svc.verify(token, { readOnly: true });
  assert.ok(r.ok && !r.renewToken);
  assert.equal(repo.touches, 0);
  assert.equal(repo.finds, 1);           // cache entry was 50 min old → one read
  await svc.verify(token, { readOnly: true });
  assert.equal(repo.finds, 1);           // now cached
});

test('DB error: reports unavailable with whether the JWT itself is still unexpired', async () => {
  const { svc, repo, advance } = makeSessions();
  const { token } = await svc.issue(LOGIN);
  repo.failReads = true;
  advance(30_000); // cache still warm (< 60 s) → no read → fine
  assert.equal((await svc.verify(token, { readOnly: true })).ok, true);
  advance(10 * MIN); // cache cold, JWT unexpired
  const down = await svc.verify(token, { readOnly: true });
  assert.ok(!down.ok && down.code === 'unavailable' && down.jwtUnexpired === true && down.claims.sid);
  advance(2 * 3_600_000); // JWT expired
  const downExpired = await svc.verify(token);
  assert.ok(!downExpired.ok && downExpired.code === 'unavailable' && downExpired.jwtUnexpired === false);
});

test('purge: events past retention, sessions dead for 30+ days', async () => {
  const { svc, repo, events } = makeSessions({ AUTH_EVENTS_RETENTION_DAYS: '90' });
  assert.deepEqual(await svc.purge(), { events: 5, sessions: 2 });
  assert.equal(events.purgedDays, 90);
  assert.deepEqual(repo.purgeArgs, [{ idleDays: 7, absoluteDays: 30 }, 30]);
});
