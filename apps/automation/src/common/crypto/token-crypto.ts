// token-crypto.ts — pure, unit-testable AES-256-GCM helpers for encrypting
// secret tokens at rest. The on-disk format is a self-describing string:
//
//     enc:v1:<ivB64>:<tagB64>:<ctB64>
//
// where iv is a 12-byte random nonce, tag is the 16-byte GCM auth tag, and ct
// is the ciphertext — all base64. The `enc:v1:` prefix lets callers tell an
// encrypted blob apart from a legacy plaintext value (see isEncrypted), so old
// rows keep working unchanged. No secret is ever logged here — these are pure
// transforms; the caller decides what to do with the plaintext.
import * as crypto from 'crypto';

const PREFIX = 'enc:v1:';
const IV_BYTES = 12; // GCM standard nonce length

/**
 * Derive a fixed 32-byte AES-256 key from an arbitrary passphrase. SHA-256 of
 * the UTF-8 secret — accepts any-length master key, always yields 32 bytes.
 */
export function keyFromSecret(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

/** Encrypt plaintext → `enc:v1:<ivB64>:<tagB64>:<ctB64>` with a fresh random IV. */
export function encryptToken(plaintext: string, secret: string): string {
  const key = keyFromSecret(secret);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/** Reverse encryptToken. Throws on a malformed blob or on tamper (GCM auth). */
export function decryptToken(blob: string, secret: string): string {
  if (!isEncrypted(blob)) throw new Error('decryptToken: value is not an enc:v1 blob');
  const parts = blob.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('decryptToken: malformed enc:v1 blob');
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_BYTES) throw new Error('decryptToken: bad IV length');
  const key = keyFromSecret(secret);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  // .final() throws if the GCM tag does not match (tampering / wrong key).
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** True when the value is an enc:v1 encrypted blob (vs legacy plaintext). */
export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Decrypt if encrypted; otherwise pass the (legacy plaintext) value through. */
export function maybeDecrypt(value: string, secret: string): string {
  return isEncrypted(value) ? decryptToken(value, secret) : value;
}
