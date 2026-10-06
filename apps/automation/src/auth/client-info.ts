import { isIP } from 'net';

/**
 * Client identity helpers for the auth audit (spec 028): the normalized client
 * IP, its network prefix (the "same network" test of the new-device check) and a
 * short User-Agent family ("Chrome · macOS") for the session list and alerts.
 * Nothing here is a security boundary — the UA is client-supplied.
 */

/** `req.ip` (resolved through the trusted proxy chain in main.ts), IPv4-mapped IPv6 unwrapped; null when not an IP. */
export function clientIp(req: { ip?: string; socket?: { remoteAddress?: string } }): string | null {
  return normalizeIp(req.ip ?? req.socket?.remoteAddress ?? null);
}

export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const ip = raw.startsWith('::ffff:') && isIP(raw.slice(7)) === 4 ? raw.slice(7) : raw;
  return isIP(ip) ? ip : null;
}

/** IPv4 → its /24 (`1.2.3.0/24`), IPv6 → its /48; null for anything else. */
export function ipPrefix(raw: string | null | undefined): string | null {
  const ip = normalizeIp(raw);
  if (!ip) return null;
  if (isIP(ip) === 4) return `${ip.split('.').slice(0, 3).join('.')}.0/24`;
  return `${expandIpv6(ip).slice(0, 3).join(':')}::/48`;
}

/** Full 8-group form of an IPv6 address (lower-case, no leading zeros). */
function expandIpv6(ip: string): string[] {
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = ip.includes('::') && tail ? tail.split(':') : [];
  const fill = ip.includes('::') ? Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((g) => (g.replace(/^0+(?=.)/, '') || '0'));
}

/** Browser + OS family, e.g. "Chrome · macOS"; "Unknown device" when nothing matches. */
export function uaFamily(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : /^curl\//.test(ua) ? 'curl'
    : null;
  const os =
    /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux'
    : null;
  if (!browser && !os) return 'Unknown device';
  return [browser ?? 'Browser', os].filter(Boolean).join(' · ');
}

/** The User-Agent header, capped so a hostile client can't bloat the audit rows. */
export function userAgentOf(req: { headers?: Record<string, unknown> }): string | null {
  const ua = req.headers?.['user-agent'];
  return typeof ua === 'string' && ua ? ua.slice(0, 400) : null;
}
