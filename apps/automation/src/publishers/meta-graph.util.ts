// meta-graph.util.ts — shared Graph API helpers for the Meta publishers.
import axios from 'axios';
import type { ConfigService } from '@nestjs/config';

export const FACEBOOK_GRAPH = 'https://graph.facebook.com';
export const THREADS_GRAPH  = 'https://graph.threads.net';

export function graphVersion(config: ConfigService): string {
  return config.get<string>('META_GRAPH_VERSION') ?? 'v21.0';
}

/**
 * Threads runs on its own Graph host (graph.threads.net) with an INDEPENDENT
 * version line — it does NOT accept Facebook's v21.0 (you get "Object with ID
 * 'v21.0' does not exist"). Its current published version is v1.0.
 */
export function threadsVersion(config: ConfigService): string {
  return config.get<string>('THREADS_GRAPH_VERSION') ?? 'v1.0';
}

export function graphTimeout(config: ConfigService): number {
  const n = parseInt(config.get<string>('FETCH_TIMEOUT') ?? '15000', 10);
  return Number.isFinite(n) ? n : 15000;
}

/** Strip the access token (explicit value + `access_token=` param) from a string. */
export function redactToken(s: string, token: string): string {
  let out = String(s).replace(/access_token=[^&\s'"]+/gi, 'access_token=<REDACTED>');
  if (token) out = out.split(token).join('<REDACTED>');
  return out;
}

/**
 * True when a Meta publish error is PERMANENT for this media — the same image
 * will never succeed (bad aspect ratio, unsupported format, bad dimensions).
 * Strategies use this to mark a deterministically-failing row as done for the
 * destination so its publish queue advances instead of dead-locking on it.
 * Transient errors (network, rate limit, 5xx) return false and stay retriable.
 */
export function isPermanentMetaMediaError(message: string): boolean {
  return /aspect ratio|not supported|unsupported|invalid (image|media|parameter)|media (type|format)|image (size|dimension)|resolution|pixel|too (large|small|big|tall|wide)/i
    .test(message ?? '');
}

/** POST to a Graph endpoint with query params; returns the JSON body. Throws a
 *  token-redacted Error on failure. */
export async function graphPost(
  url: string,
  params: Record<string, string>,
  timeout: number,
  token: string,
): Promise<any> {
  try {
    const res = await axios.post(url, null, { params, timeout });
    return res.data;
  } catch (err: any) {
    const desc = err?.response?.data?.error?.message ?? err?.message ?? 'unknown';
    throw new Error(redactToken(String(desc), token));
  }
}

export async function graphGet(
  url: string,
  params: Record<string, string>,
  timeout: number,
  token: string,
): Promise<any> {
  try {
    const res = await axios.get(url, { params, timeout });
    return res.data;
  } catch (err: any) {
    const desc = err?.response?.data?.error?.message ?? err?.message ?? 'unknown';
    throw new Error(redactToken(String(desc), token));
  }
}
