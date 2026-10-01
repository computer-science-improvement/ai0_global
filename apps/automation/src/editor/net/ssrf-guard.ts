import { lookup as dnsLookup } from 'dns/promises';
import { isIP } from 'net';

export type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

export function isPrivateAddress(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (v4ToInt(base) & mask);
    });
  }
  if (fam === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
  }
  return true; // not an IP at all → treat as unsafe
}

/**
 * Throws unless `raw` is an http(s) URL on a standard port whose host resolves
 * only to public addresses. Call again for every redirect hop.
 */
export async function assertPublicUrl(raw: string, lookup: Lookup = defaultLookup): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('invalid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`scheme ${url.protocol} not allowed`);
  if (url.username || url.password) throw new Error('credentials in URL not allowed');
  if (url.port && !['80', '443', '8080', '8443'].includes(url.port)) throw new Error(`port ${url.port} not allowed`);

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error(`host ${host} not allowed`);
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`address ${host} is private`);
    return url;
  }
  if (!host.includes('.')) throw new Error(`host ${host} not allowed`);

  const addrs = await lookup(host);
  if (!addrs.length) throw new Error(`host ${host} does not resolve`);
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  if (bad) throw new Error(`host ${host} resolves to private address ${bad.address}`);
  return url;
}
