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

/** GET with SSRF protection on every hop. */
export async function safeGet(
  raw: string,
  opts: { lookup?: Lookup; get?: RawGet; timeoutMs?: number; accept?: string } = {},
): Promise<SafeGetResult> {
  const { url, res } = await guardedGet(raw, opts, 'text');
  return {
    url,
    status:      res.status,
    contentType: String(res.headers?.['content-type'] ?? ''),
    body:        typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? ''),
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
