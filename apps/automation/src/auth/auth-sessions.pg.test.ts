/**
 * Integration tests for spec 028 (migration 055) against a throwaway Postgres
 * with all migrations applied. Skipped unless EDITOR_PG_TEST_URL is set, e.g.
 *   EDITOR_PG_TEST_URL=postgres://ai0@localhost:54329/ai0 npx tsx --test src/auth/auth-sessions.pg.test.ts
 * Never point this at a real database: it writes and deletes rows.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { JwtService } from '@nestjs/jwt';
import { AuthSessionsRepository } from './auth-sessions.repository';
import { AuthEventsRepository } from './auth-events.repository';
import { SessionService } from './session.service';
import { AuthService } from './auth.service';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let pool: Pool;
const UA = 'pgtest-agent/1.0';

async function cleanup() {
  await pool.query(`DELETE FROM auth_sessions WHERE user_agent LIKE 'pgtest-%'`);
  await pool.query(`DELETE FROM auth_events WHERE user_agent LIKE 'pgtest-%'`);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

function makeService() {
  const sessions = new AuthSessionsRepository(pool);
  const events = new AuthEventsRepository(pool);
  const svc = new SessionService(sessions, events, new JwtService({ secret: 'pg-test' }), { get: () => undefined } as any);
  return { sessions, events, svc };
}

test('login → list → revoke one → revoke-all (others) → events rows, no secret anywhere', { skip }, async () => {
  const { svc, events } = makeService();
  const config = { get: (k: string) => ({ TRACKING_TOKEN: 'pg-secret-token-value' } as Record<string, string>)[k] } as any;
  const auth = new AuthService(config, svc, events);
  const client = (ip: string) => ({ ip, userAgent: `${UA} ${ip}` });

  const a = await auth.login('token', 'pg-secret-token-value', client('10.1.0.1'));
  const b = await auth.login('link', 'pg-secret-token-value', client('10.1.0.2'));
  const c = await auth.login('token', 'pg-secret-token-value', client('10.1.0.3'));
  await assert.rejects(() => auth.login('token', 'pg-secret-token-wrong', client('10.1.0.4')));

  const mine = (await auth.listSessions(a.session.id)).filter((s) => s.userAgent?.startsWith(UA));
  assert.equal(mine.length, 3);
  assert.equal(mine.find((s) => s.current)?.id, a.session.id);
  assert.equal(mine.find((s) => s.id === b.session.id)?.method, 'link');

  assert.deepEqual(await auth.revokeSession(b.session.id, a.session.id, client('10.1.0.1')), { revoked: true, current: false });
  const all = await auth.revokeAll(a.session.id, false, client('10.1.0.1'));
  assert.ok(all.revoked >= 1);
  const left = (await auth.listSessions(a.session.id)).filter((s) => s.userAgent?.startsWith(UA));
  assert.deepEqual(left.map((s) => s.id), [a.session.id]);
  const revokedC = await pool.query(`SELECT revoked_reason FROM auth_sessions WHERE id = $1`, [c.session.id]);
  assert.equal(revokedC.rows[0].revoked_reason, 'revoke_all');

  const { rows } = await pool.query(
    `SELECT kind, method, code FROM auth_events WHERE user_agent LIKE $1 OR session_id = ANY($2) ORDER BY id`,
    [`${UA}%`, [a.session.id, b.session.id, c.session.id]]);
  assert.deepEqual(rows.map((r) => r.kind), ['login_ok', 'login_ok', 'login_ok', 'login_failed', 'revoked', 'revoke_all']);
  assert.equal(rows[1].method, 'link');
  assert.equal(rows[3].code, 'bad_token');

  const dump = JSON.stringify((await pool.query(
    `SELECT * FROM auth_sessions WHERE user_agent LIKE $1`, [`${UA}%`])).rows)
    + JSON.stringify((await pool.query(`SELECT * FROM auth_events WHERE user_agent LIKE $1`, [`${UA}%`])).rows);
  assert.doesNotMatch(dump, /pg-secret/);
  assert.doesNotMatch(dump, /eyJ/); // no JWT either
});

test('055: applied, recorded, and the CHECKs hold', { skip }, async () => {
  const { rows } = await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '055_auth_sessions'`);
  assert.equal(rows.length, 1);
  await assert.rejects(() => pool.query(`INSERT INTO auth_sessions (method, subject_id) VALUES ('password', 1)`), /check/);
  await assert.rejects(() => pool.query(`INSERT INTO auth_events (kind) VALUES ('login_maybe')`), /check/);
});

test('055: no column could hold a token, a token prefix or a widget hash', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('auth_sessions','auth_events') ORDER BY 1, 2`);
  const cols = rows.map((r) => `${r.table_name}.${r.column_name}`);
  assert.ok(cols.length >= 20);
  for (const c of cols) assert.doesNotMatch(c, /token|hash|secret|jwt|password/i, c);
});

test('sessions: issue → verify → list → revoke one → revoke-all others; dead sessions purge', { skip }, async () => {
  const { svc, sessions, events } = makeService();
  const base = { method: 'token' as const, subjectId: 0, firstName: 'Operator', username: 'token', userAgent: UA };
  const a = await svc.issue({ ...base, ip: '10.0.0.1' });
  const b = await svc.issue({ ...base, ip: '::ffff:10.0.0.2'.slice(7) });
  const c = await svc.issue({ ...base, method: 'telegram', subjectId: 42, ip: '2001:db8::1' });

  const v = await svc.verify(a.token);
  assert.ok(v.ok);

  const live = (await svc.listLive()).filter((s) => s.userAgent === UA).map((s) => s.id).sort();
  assert.deepEqual(live, [a.session.id, b.session.id, c.session.id].sort());
  const row = await sessions.findById(c.session.id);
  assert.equal(row?.ip, '2001:db8::1');
  assert.equal(row?.subjectId, 42);

  assert.equal(await svc.revoke(b.session.id, 'revoked'), true);
  assert.equal(await svc.revoke(b.session.id, 'revoked'), false);
  assert.deepEqual(await svc.verify(b.token), { ok: false, code: 'session_revoked', sid: b.session.id });

  const others = await svc.revokeAll(a.session.id, 'revoke_all');
  assert.ok(others.includes(c.session.id));
  assert.ok(!others.includes(a.session.id));
  assert.equal((await svc.verify(a.token)).ok, true);
  assert.deepEqual(await svc.verify(c.token), { ok: false, code: 'session_revoked', sid: c.session.id });

  // Age the revoked rows past the 30-day grace → purged; the live one stays.
  await pool.query(`UPDATE auth_sessions SET revoked_at = now() - interval '31 days' WHERE id = ANY($1)`, [[b.session.id, c.session.id]]);
  await svc.purge();
  assert.equal(await sessions.findById(b.session.id), null);
  assert.equal(await sessions.findById(c.session.id), null);
  assert.ok(await sessions.findById(a.session.id));

  // touch moves last_seen; an idle-expired session drops out of the live list.
  await pool.query(`UPDATE auth_sessions SET last_seen_at = now() - interval '8 days' WHERE id = $1`, [a.session.id]);
  assert.ok(!(await svc.listLive()).some((s) => s.id === a.session.id));
  await sessions.touch(a.session.id, new Date());
  assert.ok((await svc.listLive()).some((s) => s.id === a.session.id));

  // Events: insert, read back newest first, recent logins exclude the given session.
  await events.record({ kind: 'login_ok', method: 'token', sessionId: a.session.id, subjectId: 0, ip: '10.0.0.1', userAgent: UA });
  await events.record({ kind: 'login_failed', method: 'token', code: 'bad_token', ip: '10.0.0.9', userAgent: UA });
  const recent = (await events.recent(10)).filter((e) => e.userAgent === UA);
  assert.equal(recent[0].kind, 'login_failed');
  assert.equal(recent[0].code, 'bad_token');
  assert.equal(recent[1].sessionId, a.session.id);
  const logins = (await events.recentLogins(30, null)).filter((l) => l.userAgent === UA);
  assert.deepEqual(logins, [{ ip: '10.0.0.1', userAgent: UA }]);
  assert.equal((await events.recentLogins(30, a.session.id)).filter((l) => l.userAgent === UA).length, 0);

  await pool.query(`UPDATE auth_events SET at = now() - interval '181 days' WHERE user_agent = $1 AND kind = 'login_failed'`, [UA]);
  await svc.purge();
  assert.equal((await events.recent(50)).filter((e) => e.userAgent === UA && e.kind === 'login_failed').length, 0);
});
