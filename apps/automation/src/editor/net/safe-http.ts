import axios from 'axios';
import { assertPublicUrl, Lookup } from './ssrf-guard';

export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

export interface SafeGetResult {
  url:         string;   // final URL after redirects
  status:      number;
  contentType: string;
  body:        string;
}

export interface SafeGetBytesResult {
  url:         string;
  status:      number;
  contentType: string;
  body:        Buffer;
}

export type RawGet = (url: string, cfg: Record<string, unknown>) => Promise<{ status: number; headers: Record<string, any>; data: any }>;

const MAX_REDIRECTS = 3;
const MAX_BYTES     = 2_000_000;

interface SafeOpts { lookup?: Lookup; get?: RawGet; timeoutMs?: number; accept?: string; maxBytes?: number }

/**
 * Redirects are followed manually so each Location is re-validated (axios'
 * built-in follow would skip the check).
 */
async function guardedGet(raw: string, opts: SafeOpts, responseType: 'text' | 'arraybuffer') {
  const get: RawGet = opts.get ?? ((u, c) => axios.get(u, c));
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicUrl(current, opts.lookup);
    const res = await get(url.toString(), {
      timeout:          opts.timeoutMs ?? 10_000,
      maxRedirects:     0,
      maxContentLength: opts.maxBytes ?? MAX_BYTES,
      responseType,
      transformResponse: (d: unknown) => d,
      validateStatus:   () => true,
      headers: {
        // A browser User-Agent like the legacy fetchers: news sites behind Cloudflare answer 403 to bot-like agents.
        'User-Agent':      BROWSER_USER_AGENT,
        Accept:            opts.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5',
        'Accept-Language': 'uk,en;q=0.8',
      },
    });
    if (res.status >= 300 && res.status < 400 && res.headers?.location) {
      current = new URL(String(res.headers.location), url).toString();
      continue;
    }
    return { url: url.toString(), res };
  }
  throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
}

/** The charset a response declares: the Content-Type header, then a BOM, then `<meta charset>` / `<?xml encoding>`. */
export function declaredCharset(contentType: string, bytes: Buffer): string | null {
  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  const head = bytes.subarray(0, 4096).toString('latin1');
  const fromDoc = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] ?? /<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)/i.exec(head)?.[1];
  return fromDoc ? fromDoc.toLowerCase() : null;
}

/**
 * Spec 037 T6: bytes → text in the page's own charset. axios' `text` response always decoded UTF-8, so a
 * windows-1251 / koi8-u page came back as U+FFFD in every Cyrillic letter (and the model could carry them into a
 * post). Unknown or unsupported labels fall back to UTF-8.
 */
export function decodeBody(bytes: Buffer, contentType: string): string {
  const charset = declaredCharset(contentType, bytes) ?? 'utf-8';
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder('utf-8'); }
  return decoder.decode(bytes);
}

/** GET with SSRF protection on every hop; the body decoded in the charset the page declares. */
export async function safeGet(
  raw: string,
  opts: { lookup?: Lookup; get?: RawGet; timeoutMs?: number; accept?: string } = {},
): Promise<SafeGetResult> {
  const { url, res } = await guardedGet(raw, opts, 'arraybuffer');
  const contentType = String(res.headers?.['content-type'] ?? '');
  const d = res.data;
  const bytes = Buffer.isBuffer(d) ? d : d instanceof ArrayBuffer ? Buffer.from(d) : ArrayBuffer.isView(d) ? Buffer.from(d.buffer, d.byteOffset, d.byteLength) : null;
  return {
    url,
    status: res.status,
    contentType,
    // Test seams may answer with a string or a parsed object.
    body:   bytes ? decodeBody(bytes, contentType) : typeof d === 'string' ? d : JSON.stringify(d ?? ''),
  };
}

/** Binary GET (images for rendered slides) with the same SSRF protection; default cap 8 MB. */
export async function safeGetBytes(
  raw: string,
  opts: { lookup?: Lookup; get?: RawGet; timeoutMs?: number; accept?: string; maxBytes?: number } = {},
): Promise<SafeGetBytesResult> {
  const { url, res } = await guardedGet(raw, { accept: 'image/png,image/jpeg,image/*;q=0.8', maxBytes: 8_000_000, ...opts }, 'arraybuffer');
  const d = res.data;
  return {
    url,
    status:      res.status,
    contentType: String(res.headers?.['content-type'] ?? ''),
    body:        Buffer.isBuffer(d) ? d : d instanceof ArrayBuffer ? Buffer.from(d) : Buffer.from(typeof d === 'string' ? d : ''),
  };
}
