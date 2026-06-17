import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  keyFromSecret, encryptToken, decryptToken, isEncrypted, maybeDecrypt,
} from './token-crypto';

const SECRET = 'correct horse battery staple';

test('keyFromSecret yields a 32-byte buffer for any passphrase', () => {
  assert.equal(keyFromSecret('x').length, 32);
  assert.equal(keyFromSecret(SECRET).length, 32);
});

test('round-trip: decrypt(encrypt(x)) === x', () => {
  const plain = 'BOT_TOKEN:123:abcDEF-_';
  const blob = encryptToken(plain, SECRET);
  assert.ok(isEncrypted(blob), 'blob should be marked encrypted');
  assert.equal(decryptToken(blob, SECRET), plain);
});

test('round-trip handles unicode + empty string', () => {
  for (const plain of ['', 'токен 🔐 secret']) {
    assert.equal(decryptToken(encryptToken(plain, SECRET), SECRET), plain);
  }
});

test('different IV each call → different ciphertext for same input', () => {
  const a = encryptToken('same', SECRET);
  const b = encryptToken('same', SECRET);
  assert.notEqual(a, b, 'two encryptions must differ (random IV)');
  assert.equal(decryptToken(a, SECRET), 'same');
  assert.equal(decryptToken(b, SECRET), 'same');
});

test('tamper with ciphertext → throws (GCM auth)', () => {
  const blob = encryptToken('secret', SECRET);
  const [p, v, iv, tag, ct] = blob.split(':');
  // flip a char in the ciphertext segment
  const flipped = ct[0] === 'A' ? 'B' + ct.slice(1) : 'A' + ct.slice(1);
  const tampered = [p, v, iv, tag, flipped].join(':');
  assert.throws(() => decryptToken(tampered, SECRET));
});

test('tamper with auth tag → throws', () => {
  const blob = encryptToken('secret', SECRET);
  const [p, v, iv, tag, ct] = blob.split(':');
  const flipped = tag[0] === 'A' ? 'B' + tag.slice(1) : 'A' + tag.slice(1);
  const tampered = [p, v, iv, flipped, ct].join(':');
  assert.throws(() => decryptToken(tampered, SECRET));
});

test('wrong secret → throws', () => {
  const blob = encryptToken('secret', SECRET);
  assert.throws(() => decryptToken(blob, 'wrong key'));
});

test('malformed blob → throws', () => {
  assert.throws(() => decryptToken('enc:v1:onlyonepart', SECRET));
  assert.throws(() => decryptToken('not-encrypted-at-all', SECRET));
});

test('isEncrypted true for enc:v1 prefix, false otherwise', () => {
  assert.equal(isEncrypted('enc:v1:a:b:c'), true);
  assert.equal(isEncrypted('plain-token'), false);
  assert.equal(isEncrypted(''), false);
});

test('maybeDecrypt passes plaintext through unchanged', () => {
  assert.equal(maybeDecrypt('PLAINTEXT_TOKEN', SECRET), 'PLAINTEXT_TOKEN');
});

test('maybeDecrypt decrypts an encrypted blob', () => {
  const blob = encryptToken('hidden', SECRET);
  assert.equal(maybeDecrypt(blob, SECRET), 'hidden');
});
