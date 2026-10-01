import axios from 'axios';
import { assertPublicUrl, Lookup } from './ssrf-guard';

export interface SafeGetResult {
  url:         string;   // final URL after redirects
  status:      number;
  contentType: string;
  body:        string;
}

export type RawGet = (url: string, cfg: Record<string, unknown>) => Promise<{ status: number; headers: Record<string, any>; data: any }>;

const MAX_REDIRECTS = 3;
const MAX_BYTES     = 2_000_000;

/**
 * GET with SSRF protection on every hop: redirects are followed manually so
 * each Location is re-validated (axios' built-in follow would skip the check).
 */
export async function safeGet(
  raw: string,
  opts: { lookup?: Lookup; get?: RawGet; timeoutMs?: number; accept?: string } = {},
): Promise<SafeGetResult> {
  const get: RawGet = opts.get ?? ((u, c) => axios.get(u, c));
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicUrl(current, opts.lookup);
    const res = await get(url.toString(), {
      timeout:          opts.timeoutMs ?? 10_000,
      maxRedirects:     0,
      maxContentLength: MAX_BYTES,
      responseType:     'text',
      transformResponse: (d: unknown) => d,
      validateStatus:   () => true,
      headers: {
        'User-Agent': 'ai0-editor/1.0 (+https://ai0.global)',
        Accept:       opts.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5',
      },
    });
    if (res.status >= 300 && res.status < 400 && res.headers?.location) {
      current = new URL(String(res.headers.location), url).toString();
      continue;
    }
    return {
      url:         url.toString(),
      status:      res.status,
      contentType: String(res.headers?.['content-type'] ?? ''),
      body:        typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? ''),
    };
  }
  throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
}
