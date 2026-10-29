import { createHash } from 'crypto';
import axios, { type AxiosProxyConfig } from 'axios';
import { Logger } from '@nestjs/common';
import { assertPublicUrl, Lookup } from './ssrf-guard';

export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

export interface SafeGetResult {
  url:         string;   // final URL after redirects
  status:      number;
  contentType: string;
  body:        string;
  /** Spec 076 FR-003: the final request went through the per-host egress proxy. */
  via_proxy:   boolean;
}

export interface SafeGetBytesResult {
  url:         string;
  status:      number;
  contentType: string;
  body:        Buffer;
  via_proxy:   boolean;
}

export type RawGet = (url: string, cfg: Record<string, unknown>) => Promise<{ status: number; headers: Record<string, any>; data: any }>;

const MAX_REDIRECTS = 3;
const MAX_BYTES     = 2_000_000;

/** Reads a setting; the default is the process environment (`SettingsService.setValue` writes it at once, so a change is live). */
type EnvFn = (key: string) => string | undefined;
const processEnv: EnvFn = (k) => process.env[k];

interface SafeOpts { lookup?: Lookup; get?: RawGet; timeoutMs?: number; accept?: string; maxBytes?: number; env?: EnvFn }

/** `EGRESS_PROXY_URL` as an axios proxy: only an http: / https: URL counts (axios tunnels HTTPS targets with CONNECT); null otherwise. */
function parseProxyUrl(raw: string): AxiosProxyConfig | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null;
  const protocol = u.protocol.slice(0, -1);
  const port = u.port ? Number(u.port) : protocol === 'https' ? 443 : 80;
  const auth = u.username || u.password ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : undefined;
  return { protocol, host: u.hostname, port, ...(auth ? { auth } : {}) };
}

/** The hosts of `EGRESS_PROXY_HOSTS`: lower-cased, without a leading `www.`. */
export function proxyHosts(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((h) => h.trim().toLowerCase().replace(/^www\./, '')).filter(Boolean);
}

const logger = new Logger('EgressProxy');
const warned = new Set<string>();
/** One warning per distinct malformed value (keyed by a hash); the value itself, which may hold credentials, is never logged. */
function warnMalformed(raw: string, warn: (msg: string) => void): void {
  const id = createHash('sha256').update(raw).digest('hex');
  if (warned.has(id)) return;
  warned.add(id);
  warn('EGRESS_PROXY_URL is not an http or https proxy URL: the hosts in EGRESS_PROXY_HOSTS are read directly');
}

/**
 * Spec 076 FR-003: the proxy for one host, null for a direct request. A host uses the proxy only when `EGRESS_PROXY_HOSTS`
 * lists it (or its parent domain); every other host gets no `proxy` key, so a process-wide `HTTPS_PROXY` keeps working for
 * it. A malformed `EGRESS_PROXY_URL` (also `socks5://`) means a direct request. Model, Telegram and Meta traffic never calls this.
 */
export function egressProxyFor(host: string, env: EnvFn = processEnv, warn: (msg: string) => void = (m) => logger.warn(m)): AxiosProxyConfig | null {
  const raw = env('EGRESS_PROXY_URL')?.trim();
  if (!raw) return null;
  const h = host.toLowerCase().replace(/^www\./, '');
  if (!proxyHosts(env('EGRESS_PROXY_HOSTS')).some((l) => h === l || h.endsWith(`.${l}`))) return null;
  const proxy = parseProxyUrl(raw);
  if (!proxy) warnMalformed(raw, warn);
  return proxy;
}

/** True when `EGRESS_PROXY_URL` holds a usable http(s) proxy: the source panel offers "Route via proxy" only then. */
export function egressProxyConfigured(env: EnvFn = processEnv): boolean {
  const raw = env('EGRESS_PROXY_URL')?.trim();
  return !!raw && parseProxyUrl(raw) !== null;
}

/**
 * Redirects are followed manually so each Location is re-validated (axios'
 * built-in follow would skip the check). The SSRF check runs on every target before the request, proxy or not, and each
 * hop picks its own proxy: a redirect to an unlisted host goes direct.
 */
async function guardedGet(raw: string, opts: SafeOpts, responseType: 'text' | 'arraybuffer') {
  const get: RawGet = opts.get ?? ((u, c) => axios.get(u, c));
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicUrl(current, opts.lookup);
    const proxy = egressProxyFor(url.hostname, opts.env);
    const res = await get(url.toString(), {
      timeout:          opts.timeoutMs ?? 10_000,
      maxRedirects:     0,
      maxContentLength: opts.maxBytes ?? MAX_BYTES,
      responseType,
      transformResponse: (d: unknown) => d,
      validateStatus:   () => true,
      ...(proxy ? { proxy } : {}),
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
    return { url: url.toString(), res, viaProxy: !!proxy };
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
  opts: { lookup?: Lookup; get?: RawGet; timeoutMs?: number; accept?: string; env?: EnvFn } = {},
): Promise<SafeGetResult> {
  const { url, res, viaProxy } = await guardedGet(raw, opts, 'arraybuffer');
  const contentType = String(res.headers?.['content-type'] ?? '');
  const d = res.data;
  const bytes = Buffer.isBuffer(d) ? d : d instanceof ArrayBuffer ? Buffer.from(d) : ArrayBuffer.isView(d) ? Buffer.from(d.buffer, d.byteOffset, d.byteLength) : null;
  return {
    url,
    status: res.status,
    contentType,
    // Test seams may answer with a string or a parsed object.
    body:   bytes ? decodeBody(bytes, contentType) : typeof d === 'string' ? d : JSON.stringify(d ?? ''),
    via_proxy: viaProxy,
  };
}

/** Binary GET (images for rendered slides) with the same SSRF protection; default cap 8 MB. */
export async function safeGetBytes(
  raw: string,
  opts: { lookup?: Lookup; get?: RawGet; timeoutMs?: number; accept?: string; maxBytes?: number; env?: EnvFn } = {},
): Promise<SafeGetBytesResult> {
  const { url, res, viaProxy } = await guardedGet(raw, { accept: 'image/png,image/jpeg,image/*;q=0.8', maxBytes: 8_000_000, ...opts }, 'arraybuffer');
  const d = res.data;
  return {
    url,
    status:      res.status,
    contentType: String(res.headers?.['content-type'] ?? ''),
    body:        Buffer.isBuffer(d) ? d : d instanceof ArrayBuffer ? Buffer.from(d) : Buffer.from(typeof d === 'string' ? d : ''),
    via_proxy:   viaProxy,
  };
}
