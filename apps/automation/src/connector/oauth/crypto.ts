import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/** Token prefixes make a leaked value recognisable (secret scanners, support) and keep kinds from being mixed up. */
export const PREFIX = { code: 'ai0mcp_c_', access: 'ai0mcp_at_', refresh: 'ai0mcp_rt_' } as const;
export type TokenKind = keyof typeof PREFIX;

/** 32 random bytes, base64url, with the kind's prefix. */
export function newToken(kind: TokenKind): string {
  return PREFIX[kind] + randomBytes(32).toString('base64url');
}

/** An opaque id with no prefix (consent request ids, DCR client ids). */
export function newOpaqueId(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Only this hash is ever stored or compared; the raw token is never logged. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)). */
export function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Constant-time comparison of two strings of any length. */
export function safeEq(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** RFC 7636: verifier is 43..128 chars of [A-Za-z0-9-._~]; a challenge is the 43-char base64url of a SHA-256. */
export const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
export const CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/;
