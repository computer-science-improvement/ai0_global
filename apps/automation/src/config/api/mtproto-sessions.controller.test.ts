import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MtprotoSessionsController } from './mtproto-sessions.controller';
import { SecretsService } from '../../common/crypto/secrets.service';

const MASTER = 'a'.repeat(64);
const encSecrets = () =>
  new SecretsService({ get: (k: string) => (k === 'TOKEN_ENCRYPTION_KEY' ? MASTER : undefined) } as any);

// A real encrypted blob so the controller's maybeDecrypt() path works in tests.
const SAMPLE_SESSION_ENC = encSecrets().encrypt('SAMPLE_SESSION');

function fullRow(over: any = {}) {
  return {
    id: 's1', label: 'Tracker', session_enc: SAMPLE_SESSION_ENC, active: true,
    username: 'acct', phone: '+380', tg_user_id: '42',
    last_verified_at: new Date('2026-06-17T00:00:00Z'), verify_error: null,
    created_at: new Date('2026-06-01T00:00:00Z'),
    ...over,
  };
}

function make(over: any = {}) {
  const insertCalls: any[] = [];
  const markVerifiedCalls: any[] = [];
  const markVerifyErrorCalls: any[] = [];
  const setActiveCalls: any[] = [];
  const repo = {
    list: async () => over.list ?? [fullRow()],
    findById: async (id: string) => ('row' in over ? over.row : fullRow({ id })),
    insert: async (input: any) => { insertCalls.push(input); return fullRow({ id: 'new-1', ...input }); },
    delete: async () => (over.deleted ?? true),
    setActive: async (id: string, active: boolean) => { setActiveCalls.push({ id, active }); },
    markVerified: async (id: string, meta: any) => { markVerifiedCalls.push({ id, meta }); },
    markVerifyError: async (id: string, msg: string) => { markVerifyErrorCalls.push({ id, msg }); },
  };
  const verifyClient = {
    verify: over.verify ?? (async () => ({ username: 'acct', phone: '+380', tgUserId: '42' })),
  };
  const secrets = over.secrets ?? encSecrets();
  const c = new MtprotoSessionsController(repo as any, verifyClient as any, secrets);
  return { c, insertCalls, markVerifiedCalls, markVerifyErrorCalls, setActiveCalls, secrets };
}

test('list() projection NEVER includes session_enc', async () => {
  const { c } = make();
  const out = (await c.list()) as any[];
  assert.equal(out.length, 1);
  assert.equal('session_enc' in out[0], false, 'session_enc must never be exposed');
  assert.equal('session' in out[0], false);
  // Safe display fields are present.
  assert.equal(out[0].id, 's1');
  assert.equal(out[0].label, 'Tracker');
  assert.equal(out[0].username, 'acct');
  assert.equal(out[0].phone, '+380');
  assert.equal(out[0].tg_user_id, '42');
  assert.equal(out[0].active, true);
  assert.ok(out[0].created_at instanceof Date);
});

test('create() encrypts the session and never returns it', async () => {
  const { c, insertCalls, secrets } = make();
  const out = (await c.create({ label: 'Tracker', session: '  RAW_SESSION_STRING  ' } as any)) as any;
  assert.equal(insertCalls.length, 1);
  // Stored value is an enc:v1 blob of the TRIMMED session.
  assert.ok(insertCalls[0].session_enc.startsWith('enc:v1:'), 'session must be encrypted at rest');
  assert.equal(secrets.decrypt(insertCalls[0].session_enc), 'RAW_SESSION_STRING');
  // Response leaks neither the plaintext nor the ciphertext.
  assert.equal('session' in out, false);
  assert.equal('session_enc' in out, false);
});

test('verify() success stores display identity and returns ok+username, never the session', async () => {
  const { c, markVerifiedCalls } = make({
    verify: async () => ({ username: 'mychan', phone: '+111', tgUserId: '99' }),
  });
  const out = (await c.verify('s1')) as any;
  assert.equal(out.ok, true);
  assert.equal(out.username, 'mychan');
  assert.equal('session' in out, false);
  assert.equal(markVerifiedCalls.length, 1);
  assert.deepEqual(markVerifiedCalls[0].meta, { username: 'mychan', phone: '+111', tgUserId: '99' });
});

test('verify() decrypts the stored session before connecting', async () => {
  let received: string | undefined;
  const { c } = make({
    row: fullRow({ session_enc: encSecrets().encrypt('PLAINTEXT_SESSION') }),
    verify: async (s: string) => { received = s; return { username: 'u', phone: null, tgUserId: '1' }; },
  });
  await c.verify('s1');
  assert.equal(received, 'PLAINTEXT_SESSION', 'verify client receives the decrypted session');
});

test('verify() failure path stores a redacted error and returns ok:false', async () => {
  const { c, markVerifyErrorCalls, markVerifiedCalls } = make({
    verify: async () => { throw new Error('AUTH_KEY_UNREGISTERED'); },
  });
  const out = (await c.verify('s1')) as any;
  assert.equal(out.ok, false);
  assert.match(out.error, /AUTH_KEY_UNREGISTERED/);
  assert.equal(markVerifyErrorCalls.length, 1);
  assert.equal(markVerifiedCalls.length, 0);
  assert.equal('session' in out, false);
});

test('verify() on unknown id → 404', async () => {
  const { c } = make({ row: null });
  await assert.rejects(() => c.verify('nope'), /not found/i);
});

test('patch() toggles active', async () => {
  const { c, setActiveCalls } = make();
  const out = (await c.patch('s1', { active: false } as any)) as any;
  assert.equal(out.ok, true);
  assert.deepEqual(setActiveCalls[0], { id: 's1', active: false });
});

test('remove() returns nothing (204) and deletes', async () => {
  const { c } = make();
  const out = await c.remove('s1');
  assert.equal(out, undefined);
});
