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
    api_id: null, api_hash_enc: null,
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
  const verifyCalls: any[] = [];
  const verifyClient = {
    verify: async (s: string, creds?: any) => {
      verifyCalls.push({ s, creds });
      return over.verify ? over.verify(s, creds) : { username: 'acct', phone: '+380', tgUserId: '42' };
    },
  };
  const secrets = over.secrets ?? encSecrets();
  const c = new MtprotoSessionsController(repo as any, verifyClient as any, secrets);
  return { c, insertCalls, markVerifiedCalls, markVerifyErrorCalls, setActiveCalls, verifyCalls, secrets };
}

test('list() projection NEVER includes session_enc or api_hash_enc', async () => {
  const { c } = make({ list: [fullRow({ api_id: '123', api_hash_enc: 'enc:v1:hash' })] });
  const out = (await c.list()) as any[];
  assert.equal(out.length, 1);
  assert.equal('session_enc' in out[0], false, 'session_enc must never be exposed');
  assert.equal('session' in out[0], false);
  assert.equal('api_hash_enc' in out[0], false, 'api_hash_enc must never be exposed');
  assert.equal('apiHash' in out[0], false);
  // Safe display fields are present.
  assert.equal(out[0].id, 's1');
  assert.equal(out[0].label, 'Tracker');
  assert.equal(out[0].username, 'acct');
  assert.equal(out[0].phone, '+380');
  assert.equal(out[0].tg_user_id, '42');
  assert.equal(out[0].active, true);
  // api_id is safe to show; has_api_creds reflects a per-session secret being set.
  assert.equal(out[0].api_id, '123');
  assert.equal(out[0].has_api_creds, true);
  assert.ok(out[0].created_at instanceof Date);
});

test('list() reports has_api_creds=false when the row relies on env creds', async () => {
  const { c } = make({ list: [fullRow({ api_id: null, api_hash_enc: null })] });
  const out = (await c.list()) as any[];
  assert.equal(out[0].api_id, null);
  assert.equal(out[0].has_api_creds, false);
});

test('create() with api creds: api_id stored plaintext, api_hash encrypted, never returned', async () => {
  const { c, insertCalls, secrets } = make();
  const out = (await c.create({
    label: 'Tracker', session: 'RAW', apiId: '  12345  ', apiHash: '  deadbeef  ',
  } as any)) as any;
  assert.equal(insertCalls[0].api_id, '12345');
  assert.ok(insertCalls[0].api_hash_enc.startsWith('enc:v1:'), 'api_hash must be encrypted at rest');
  assert.equal(secrets.decrypt(insertCalls[0].api_hash_enc), 'deadbeef');
  // Response never leaks the hash (plaintext or ciphertext).
  assert.equal('apiHash' in out, false);
  assert.equal('api_hash_enc' in out, false);
});

test('create() without api creds stores nulls (env fallback)', async () => {
  const { c, insertCalls } = make();
  await c.create({ label: 'Tracker', session: 'RAW' } as any);
  assert.equal(insertCalls[0].api_id, null);
  assert.equal(insertCalls[0].api_hash_enc, null);
});

test('verify() passes the session-row app credentials to the verify client', async () => {
  const apiHashEnc = encSecrets().encrypt('SESSION_HASH');
  const { c, verifyCalls } = make({ row: fullRow({ api_id: '777', api_hash_enc: apiHashEnc }) });
  await c.verify('s1');
  assert.equal(verifyCalls[0].creds.apiId, 777);
  assert.equal(verifyCalls[0].creds.apiHash, 'SESSION_HASH');
});

test('verify() passes undefined creds when the row has none (env fallback)', async () => {
  const { c, verifyCalls } = make({ row: fullRow({ api_id: null, api_hash_enc: null }) });
  await c.verify('s1');
  assert.equal(verifyCalls[0].creds.apiId, undefined);
  assert.equal(verifyCalls[0].creds.apiHash, undefined);
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
