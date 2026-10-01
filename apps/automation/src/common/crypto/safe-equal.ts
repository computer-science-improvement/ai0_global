// safe-equal.ts — constant-time comparison for secrets (Bearer tokens, API
// keys, Telegram login hashes). Both sides are SHA-256'd first so the
// comparison runs over equal-length buffers: no early exit on a length
// mismatch, so response timing leaks neither content nor length.
import { createHash, timingSafeEqual } from 'crypto';

export function safeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}
