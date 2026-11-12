import type { AuditSink } from '../audit/audit';
import { isIPv6 } from 'net';
import { CIMD_CACHE_MS, CIMD_FAIL_CACHE_MS, CIMD_MAX_BYTES, CIMD_TIMEOUT_MS, DCR_MAX_ACTIVE, DCR_PER_IP_PER_HOUR, PINNED_CIMD } from './constants';
import { newOpaqueId } from './crypto';
import { OAuthError } from './errors';
import { isAllowedRedirect } from './redirect';
import type { OAuthStore } from './store';

/** Fetches a client metadata document. Injectable so tests never touch the network. */
export type MetadataFetcher = (url: string) => Promise<{ status: number; text: string }>;

/** Global fetch: 5 s timeout, no redirects (a 3xx is a failure), at most 64 KB. */
export const defaultMetadataFetcher: MetadataFetcher = async (url) => {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(CIMD_TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (res.status >= 300 && res.status < 400) throw new Error(`redirect (${res.status})`);
  const reader = res.body?.getReader();
  if (!reader) return { status: res.status, text: '' };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > CIMD_MAX_BYTES) { await reader.cancel().catch(() => undefined); throw new Error('document too large'); }
    chunks.push(value);
  }
  return { status: res.status, text: Buffer.concat(chunks).toString('utf8') };
};

/** Per-address key for the registration limit: an IPv6 address counts by its /64 (one subscriber holds a whole /64), IPv4-mapped as IPv4. */
export function ipKey(ip: string | null): string {
  if (!ip) return 'unknown';
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4) return v4[1];
  if (!isIPv6(ip)) return ip;
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export interface ResolvedClient {
  clientId:     string;
  kind:         'cimd' | 'dcr';
  name:         string;
  redirectUris: string[];
}

export class ClientRegistry {
  private readonly cache = new Map<string, { at: number; ttl: number; doc?: { name: string; redirectUris: string[] }; err?: OAuthError }>();
  private readonly dcrByIp = new Map<string, number[]>();

  constructor(
    private readonly store: OAuthStore,
    private readonly fetcher: MetadataFetcher = defaultMetadataFetcher,
    private readonly now: () => Date = () => new Date(),
    private readonly audit?: AuditSink,
  ) {}

  /**
   * A client by id: a stored DCR client, or one of the two Claude metadata documents. Returns null when unknown or
   * revoked. Any other URL client id is unauthorized_client.
   */
  async resolve(clientId: string): Promise<ResolvedClient | null> {
    if (!clientId || clientId.length > 600) return null;
    if (/^https:\/\//i.test(clientId)) return this.resolveCimd(clientId);
    const row = await this.store.getClient(clientId);
    if (!row || row.revokedAt || row.kind !== 'dcr') return null;
    return { clientId: row.clientId, kind: 'dcr', name: row.name, redirectUris: row.redirectUris };
  }

  private async resolveCimd(url: string): Promise<ResolvedClient> {
    const pinned = PINNED_CIMD[url];
    if (!pinned) throw new OAuthError(400, 'unauthorized_client', 'This client is not allowed to connect');
    // Read only: an anonymous authorize call must not write the client row or bring a disconnected client back.
    // The row is written when the owner allows (activate), and "Disconnect" stays in force until then.
    const doc = await this.cimdDocument(url, pinned);
    return { clientId: url, kind: 'cimd', name: doc.name, redirectUris: doc.redirectUris };
  }

  /** The owner allowed this client: stores a CIMD client (clearing a Disconnect) and marks it used. A DCR client is just marked used. */
  async activate(c: ResolvedClient): Promise<void> {
    if (c.kind === 'cimd') await this.store.upsertClient({ clientId: c.clientId, kind: 'cimd', name: c.name, redirectUris: c.redirectUris }, this.now());
    else await this.store.touchClient(c.clientId, this.now());
  }

  private async cimdDocument(url: string, pinned: { name: string; redirectUris: string[] }): Promise<{ name: string; redirectUris: string[] }> {
    const t = this.now().getTime();
    const hit = this.cache.get(url);
    if (hit && t - hit.at < hit.ttl) {
      if (hit.err) throw hit.err;
      return hit.doc!;
    }
    const fallback = { name: pinned.name, redirectUris: pinned.redirectUris };
    // Fetch failed (network, timeout, redirect, size, non-200, not JSON): the pinned copy keeps Claude connectable.
    // The failure is remembered for a few minutes so repeated anonymous authorize calls do not each wait on the host.
    const failed = () => { this.cache.set(url, { at: t, ttl: CIMD_FAIL_CACHE_MS, doc: fallback }); return fallback; };
    let text: string;
    try {
      const r = await this.fetcher(url);
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      text = r.text;
    } catch {
      return failed();
    }
    let json: any;
    try { json = JSON.parse(text); } catch { return failed(); }
    const reject = (message: string): never => {
      const err = new OAuthError(400, 'unauthorized_client', message);
      this.cache.set(url, { at: t, ttl: CIMD_FAIL_CACHE_MS, err });
      throw err;
    };
    if (!json || typeof json !== 'object' || json.client_id !== url) reject('The client metadata document does not match its client_id');
    const uris = Array.isArray(json.redirect_uris) ? json.redirect_uris.filter((u: unknown): u is string => typeof u === 'string' && isAllowedRedirect(u)) : [];
    if (!uris.length) reject('The client metadata document lists no acceptable redirect_uri');
    const name = typeof json.client_name === 'string' && json.client_name.trim() ? json.client_name.trim().slice(0, 100) : pinned.name;
    const doc = { name, redirectUris: uris };
    this.cache.set(url, { at: t, ttl: CIMD_CACHE_MS, doc });
    return doc;
  }

  /** RFC 7591 registration, restricted: public clients, allowlisted redirects, per-IP and total limits. */
  async register(body: unknown, ip: string | null): Promise<Record<string, unknown>> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OAuthError(400, 'invalid_client_metadata', 'The body must be a JSON object');
    const b = body as Record<string, unknown>;
    const method = b.token_endpoint_auth_method;
    if (method !== undefined && method !== 'none') throw new OAuthError(400, 'invalid_client_metadata', 'Only token_endpoint_auth_method "none" is supported');
    const uris = b.redirect_uris;
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > 10 || !uris.every((u) => typeof u === 'string')) {
      throw new OAuthError(400, 'invalid_redirect_uri', 'redirect_uris must list 1 to 10 URLs');
    }
    const bad = (uris as string[]).find((u) => !isAllowedRedirect(u));
    if (bad !== undefined) throw new OAuthError(400, 'invalid_redirect_uri', 'redirect_uri is not allowed: only Claude callbacks and loopback URLs are accepted');
    for (const k of ['grant_types', 'response_types'] as const) {
      const v = b[k];
      const allowed = k === 'grant_types' ? ['authorization_code', 'refresh_token'] : ['code'];
      if (v !== undefined && (!Array.isArray(v) || !v.every((x) => allowed.includes(x as string)))) {
        throw new OAuthError(400, 'invalid_client_metadata', `${k} may only contain: ${allowed.join(', ')}`);
      }
    }
    const rawName = b.client_name;
    const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim().slice(0, 100) : 'MCP client';

    const t = this.now().getTime();
    const key = ipKey(ip);
    if (this.dcrByIp.size > 1000) for (const [k, v] of this.dcrByIp) if (v.every((x) => t - x >= 3600 * 1000)) this.dcrByIp.delete(k);
    const recent = (this.dcrByIp.get(key) ?? []).filter((x) => t - x < 3600 * 1000);
    if (recent.length >= DCR_PER_IP_PER_HOUR) throw new OAuthError(429, 'temporarily_unavailable', 'Too many registrations from this address; try again later');
    if ((await this.store.countActiveDcr(this.now())) >= DCR_MAX_ACTIVE) throw new OAuthError(429, 'temporarily_unavailable', 'Too many registered clients');
    recent.push(t);
    this.dcrByIp.set(key, recent);

    const clientId = `ai0mcp_dcr_${newOpaqueId(16)}`;
    await this.store.upsertClient({ clientId, kind: 'dcr', name, redirectUris: uris as string[], metadata: { grant_types: b.grant_types, scope: b.scope }, createdIp: ip }, this.now());
    await this.audit?.record({ event: 'register', clientId, ok: true, summary: `client=${name}`, ip }, this.now());
    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(t / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: Array.isArray(b.grant_types) ? b.grant_types : ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }
}
