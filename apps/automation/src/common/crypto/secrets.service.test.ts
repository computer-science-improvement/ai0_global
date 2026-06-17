import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecretsService } from './secrets.service';
import { encryptToken } from './token-crypto';

const MASTER = 'master-key';

function svc(over: Record<string, string | undefined> = {}) {
  const vars: Record<string, string | undefined> = { TOKEN_ENCRYPTION_KEY: MASTER, ...over };
  const config = { get: (k: string) => vars[k] } as any;
  return new SecretsService(config);
}

test('encrypt → decrypt round-trips with the configured key', () => {
  const s = svc();
  const blob = s.encrypt('TOKEN_VALUE');
  assert.ok(blob.startsWith('enc:v1:'));
  assert.equal(s.decrypt(blob), 'TOKEN_VALUE');
});

test('encrypt throws a clear error when key unset', () => {
  const s = svc({ TOKEN_ENCRYPTION_KEY: undefined });
  assert.throws(() => s.encrypt('x'), /TOKEN_ENCRYPTION_KEY is not set/);
});

test('maybeDecrypt passes plaintext through (key set)', () => {
  assert.equal(svc().maybeDecrypt('PLAINTEXT'), 'PLAINTEXT');
});

test('maybeDecrypt decrypts a blob (key set)', () => {
  const blob = encryptToken('hidden', MASTER);
  assert.equal(svc().maybeDecrypt(blob), 'hidden');
});

test('maybeDecrypt passes plaintext through when key unset', () => {
  const s = svc({ TOKEN_ENCRYPTION_KEY: undefined });
  assert.equal(s.maybeDecrypt('PLAINTEXT'), 'PLAINTEXT');
});

test('maybeDecrypt throws when value is encrypted but key unset', () => {
  const blob = encryptToken('hidden', MASTER);
  const s = svc({ TOKEN_ENCRYPTION_KEY: undefined });
  assert.throws(() => s.maybeDecrypt(blob), /not set/);
});

test('resolveToken prefers enc and decrypts it', () => {
  const s = svc();
  const blob = encryptToken('ENC_TOKEN', MASTER);
  const got = s.resolveToken({ enc: blob, env: 'SOME_ENV' }, () => 'ENV_TOKEN');
  assert.equal(got, 'ENC_TOKEN', 'enc must win over env');
});

test('resolveToken falls back to env when enc is null', () => {
  const s = svc();
  const got = s.resolveToken({ enc: null, env: 'BOT_TOKEN' }, (k) => (k === 'BOT_TOKEN' ? 'from-env' : undefined));
  assert.equal(got, 'from-env');
});

test('resolveToken returns undefined when neither enc nor env present', () => {
  const s = svc();
  assert.equal(s.resolveToken({ enc: null, env: null }, () => 'x'), undefined);
  assert.equal(s.resolveToken({}, () => 'x'), undefined);
});

test('resolveToken env path returns undefined when env var is unset', () => {
  const s = svc();
  assert.equal(s.resolveToken({ env: 'MISSING' }, () => undefined), undefined);
});
