import type { Pool } from 'pg';
import type { CardSource } from '../card';

/**
 * Spec 040 FR-006: hosts that refused or failed a fetch. Agents used to retry a site that answers 403 to every request
 * (48 times in a week), guess article paths that do not exist and re-read a broken feed daily. A refusal (401 / 403 / 451 /
 * 429), a DNS or TLS failure marks the host for 24 h; web_fetch / extract_images / fetch_feed then answer `host_blocked`
 * at once, without a request. A feed that does not parse marks the host for fetch_feed only.
 */
export const HOST_BLOCK_HOURS = 24;
export const REFUSAL_STATUSES = new Set([401, 403, 451, 429]);

/** `feed_*` reasons block fetch_feed only; the others block every page fetch of the host. */
export type HostFailureReason = 'refused' | 'dns' | 'tls' | 'feed_unparseable';

export interface HostBlock {
  host:       string;
  reason:     HostFailureReason;
  statusCode: number | null;
  until:      Date;
}

export interface HostFailures {
  blocked(host: string, use: 'page' | 'feed'): Promise<HostBlock | null>;
  record(host: string, reason: HostFailureReason, statusCode?: number | null): Promise<void>;
}

/** The host of a URL, without `www.` (null for a non-URL). */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase().replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

/** Where to go instead of a blocked host, when the code knows. */
export const KNOWN_ALTERNATIVES: Record<string, string> = {
  'gamerpower.com': 'fetch_api з source gamerpower_giveaways — ті самі роздачі через API',
};

/** The alternative for a host: a known API, else the card's feed on that host ("use the feed item text"). */
export function alternativeFor(host: string, cardSources: CardSource[] = []): string | null {
  const known = Object.entries(KNOWN_ALTERNATIVES).find(([h]) => host === h || host.endsWith(`.${h}`));
  if (known) return known[1];
  const feed = cardSources.find((s) => s.kind === 'rss' && hostOf(s.ref) === host);
  return feed ? `текст запису зі стрічки картки «${feed.id}» (fetch_feed: title і snippet), сторінки сайту не відкривай` : null;
}

/** DNS and TLS failures of a request (by Node / axios error code); null for anything else (timeouts, resets …). */
export function classifyFetchError(err: unknown): 'dns' | 'tls' | null {
  const e = err as { code?: string; cause?: { code?: string }; message?: string } | null;
  const code = String(e?.code ?? e?.cause?.code ?? '');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA') return 'dns';
  if (/^(CERT_|ERR_TLS_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|ERR_SSL_)/.test(code) || code === 'EPROTO') return 'tls';
  return null;
}

const REASON_TEXT: Record<HostFailureReason, string> = {
  refused:          'сайт відмовляє в доступі',
  dns:              'домен не знаходиться (DNS)',
  tls:              'помилка TLS-сертифіката',
  feed_unparseable: 'стрічка не читається як RSS/Atom',
};

/** The `host_blocked` answer: why, until when, and what to use instead. */
export function hostBlockedError(b: HostBlock, cardSources?: CardSource[]) {
  const alt = alternativeFor(b.host, cardSources);
  const why = `${REASON_TEXT[b.reason]}${b.statusCode ? ` (status ${b.statusCode})` : ''}`;
  return {
    error: 'host_blocked',
    details: `${b.host}: ${why}; до ${b.until.toISOString().slice(0, 16)}Z запити не робимо. ${alt ? `Замість цього: ${alt}.` : 'Візьми snippet зі стрічки, інше джерело або пропусти слот.'}`,
    ...(alt ? { alternative: alt } : {}),
  };
}

export class PgHostFailures implements HostFailures {
  constructor(private readonly pool: Pick<Pool, 'query'>, private readonly now: () => Date = () => new Date()) {}

  async blocked(host: string, use: 'page' | 'feed'): Promise<HostBlock | null> {
    try {
      const { rows } = await this.pool.query(
        `SELECT host, reason, status_code, blocked_until FROM source_host_failures WHERE host = $1 AND blocked_until > $2`, [host, this.now()]);
      const r = rows[0];
      if (!r) return null;
      if (String(r.reason).startsWith('feed_') && use !== 'feed') return null;
      return { host: r.host, reason: r.reason, statusCode: r.status_code ?? null, until: new Date(r.blocked_until) };
    } catch {
      return null; // never stops a fetch (e.g. before migration 079)
    }
  }

  async record(host: string, reason: HostFailureReason, statusCode: number | null = null): Promise<void> {
    const t = this.now();
    const until = new Date(t.getTime() + HOST_BLOCK_HOURS * 3_600_000);
    await this.pool.query(
      `INSERT INTO source_host_failures (host, reason, status_code, first_at, last_at, blocked_until) VALUES ($1, $2, $3, $4, $4, $5)
       ON CONFLICT (host) DO UPDATE SET reason = EXCLUDED.reason, status_code = EXCLUDED.status_code, last_at = EXCLUDED.last_at,
         blocked_until = EXCLUDED.blocked_until,
         failures = CASE WHEN source_host_failures.blocked_until > EXCLUDED.last_at THEN source_host_failures.failures + 1 ELSE 1 END,
         first_at = CASE WHEN source_host_failures.blocked_until > EXCLUDED.last_at THEN source_host_failures.first_at ELSE EXCLUDED.first_at END`,
      [host, reason, statusCode, t, until],
    ).catch(() => {});
  }
}

/** A refused / failed page fetch as the tools answer it (spec 040 FR-006). */
export interface FetchFailure { error: string; details: string; alternative?: string }

const NOT_FOUND = 'такої сторінки немає. URL бери лише зі стрічки, сторінки-списку чи результатів пошуку — шляхи не вгадуй';

/**
 * The page-fetch wrapper of web_fetch / extract_images: a blocked host is answered without a request; a refusal, DNS or TLS
 * failure marks the host; a 404 says not to guess paths. Other errors are thrown as before (the loop records tool_failed).
 */
export async function fetchPageGuarded<T extends { status: number }>(
  url: string, hosts: HostFailures | undefined, cardSources: CardSource[] | undefined, get: () => Promise<T>,
): Promise<T | FetchFailure> {
  const host = hostOf(url);
  if (host && hosts) {
    const b = await hosts.blocked(host, 'page');
    if (b) return hostBlockedError(b, cardSources);
  }
  let res: T;
  try {
    res = await get();
  } catch (err) {
    const kind = classifyFetchError(err);
    if (!kind || !host) throw err;
    await hosts?.record(host, kind);
    return { error: 'host_unreachable', details: `${host}: ${REASON_TEXT[kind]}. Не пробуй цей сайт сьогодні — інше джерело або пропусти слот.` };
  }
  if (REFUSAL_STATUSES.has(res.status)) {
    if (host) await hosts?.record(host, 'refused', res.status);
    const alt = host ? alternativeFor(host, cardSources) : null;
    return {
      error: 'http_error',
      details: `status ${res.status}: сайт не дає завантажити сторінку. Не пробуй його знову — ${alt ?? 'візьми snippet зі стрічки, інше джерело або пропусти слот'}`,
      ...(alt ? { alternative: alt } : {}),
    };
  }
  if (res.status === 404 || res.status === 410) return { error: 'http_error', details: `status ${res.status}: ${NOT_FOUND}` };
  if (res.status >= 400) return { error: 'http_error', details: `status ${res.status}` };
  return res;
}

export const isFetchFailure = (v: unknown): v is FetchFailure => !!v && typeof v === 'object' && typeof (v as FetchFailure).error === 'string';
