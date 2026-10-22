import type { Pool } from 'pg';
import type { CardSource } from '../card';

/**
 * Spec 040 FR-006: hosts that refused or failed a fetch. Agents used to retry a site that answers 403 to every request
 * (48 times in a week), guess article paths that do not exist and re-read a broken feed daily. A refusal (401 / 403 / 451 /
 * 429), a DNS or TLS failure marks the host for 24 h; web_fetch / extract_images / fetch_feed then answer `host_blocked`
 * at once, without a request. A feed that does not parse marks the host for fetch_feed only.
 *
 * Spec 061 FR-004: blocks of the same host escalate 1 d -> 3 d -> 7 d (`strikes`, kept when a block expires, reset by a
 * successful fetch), and a timeout is a 1-hour block that is not a strike (a slow site is not a hostile one).
 *
 * Spec 046 FR-009: a feed failure (not a feed, too large) marks that feed's address (`feedKey`), not the whole host — a
 * JSON API sent to fetch_feed used to block every feed of gamerpower.com for a day. An oversized feed is remembered too.
 */
export const HOST_BLOCK_HOURS = 24;
/** Block length by strike (spec 061 FR-004): the 3rd and every later strike is the cap. */
export const STRIKE_BLOCK_HOURS = [24, 72, 168] as const;
export const TIMEOUT_BLOCK_HOURS = 1;
/** A host struck this many times in a row is raised to the owner (one note, `change_source` card for a card source). */
export const STRIKES_FOR_OWNER = 3;
export const REFUSAL_STATUSES = new Set([401, 403, 451, 429]);

/** `feed_*` reasons block fetch_feed only; the others block every page fetch of the host. */
export type HostFailureReason = 'refused' | 'dns' | 'tls' | 'timeout' | 'feed_unparseable' | 'feed_too_large';

export interface HostBlock {
  host:       string;
  reason:     HostFailureReason;
  statusCode: number | null;
  until:      Date;
}

export interface HostFailures {
  blocked(host: string, use: 'page' | 'feed'): Promise<HostBlock | null>;
  record(host: string, reason: HostFailureReason, statusCode?: number | null): Promise<void>;
  /** A page of this host answered: its strikes start over (spec 061 FR-004). */
  succeeded?(host: string): Promise<void>;
}

/** The block a failure leaves: the strikes after it and when it ends; `keep` = an active longer block stays as it is. */
export interface NextBlock { strikes: number; until: Date; keep: boolean }

export interface PrevBlock { reason: string; blockedUntil: Date; strikes: number }

/** Block length in hours for the n-th strike in a row (1 d, 3 d, then 7 d). */
export const strikeHours = (strikes: number): number => STRIKE_BLOCK_HOURS[Math.min(Math.max(strikes, 1), STRIKE_BLOCK_HOURS.length) - 1];

/**
 * Spec 061 FR-004, pure: what a new failure does to the host's row. A refusal / DNS / TLS failure after the previous block
 * ended is the next strike (1 d, 3 d, 7 d); a failure inside a block is the same strike. A timeout blocks for an hour and
 * adds no strike, and never shortens a longer block. Feed failures stay a flat day on their own address.
 */
export function nextBlock(prev: PrevBlock | null, reason: HostFailureReason, now: Date): NextBlock {
  const at = (hours: number) => new Date(now.getTime() + hours * 3_600_000);
  const prevStrikes = prev?.strikes ?? 0;
  const active = !!prev && prev.blockedUntil.getTime() > now.getTime();
  if (reason === 'feed_unparseable' || reason === 'feed_too_large') return { strikes: prevStrikes, until: at(HOST_BLOCK_HOURS), keep: false };
  if (reason === 'timeout') {
    if (active && prev!.reason !== 'timeout' && prev!.blockedUntil.getTime() - now.getTime() > TIMEOUT_BLOCK_HOURS * 3_600_000) {
      return { strikes: prevStrikes, until: prev!.blockedUntil, keep: true };
    }
    return { strikes: prevStrikes, until: at(TIMEOUT_BLOCK_HOURS), keep: false };
  }
  if (active && prev!.reason !== 'timeout') return { strikes: Math.max(prevStrikes, 1), until: prev!.blockedUntil, keep: true };
  const strikes = prevStrikes + 1;
  return { strikes, until: at(strikeHours(strikes)), keep: false };
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

/** The key a feed failure is stored under: host + path (+ query), so one bad address blocks only itself. */
export function feedKey(url: string): string | null {
  const host = hostOf(url);
  if (!host) return null;
  const u = new URL(url);
  return `${host}${u.pathname.replace(/\/+$/, '')}${u.search}`;
}

/** An axios / safe-http size-limit failure (the body is over the 2 MB cap). */
export function isTooLarge(err: unknown): boolean {
  return /maxContentLength|content length|too large/i.test(String((err as { message?: string } | null)?.message ?? ''));
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

/** A request that ran out of time (Node / axios codes, AbortSignal timeout, "timeout of 10000ms exceeded"). */
export function classifyTimeout(err: unknown): boolean {
  const e = err as { code?: string; name?: string; cause?: { code?: string }; message?: string } | null;
  const code = String(e?.code ?? e?.cause?.code ?? '');
  if (code === 'ETIMEDOUT' || code === 'ECONNABORTED' || code === 'ESOCKETTIMEDOUT' || /^UND_ERR_.*TIMEOUT$/.test(code)) return true;
  if (e?.name === 'TimeoutError') return true;
  return /timeout|timed out/i.test(String(e?.message ?? ''));
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
  timeout:          'сайт не відповів вчасно',
  feed_unparseable: 'стрічка не читається як RSS/Atom',
  feed_too_large:   'стрічка більша за 2 МБ',
};

/** The `host_blocked` answer: why, until when, and what to use instead. */
export function hostBlockedError(b: HostBlock, cardSources?: CardSource[]) {
  const alt = alternativeFor(b.host.split('/')[0], cardSources);
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
    try {
      const { rows } = await this.pool.query(`SELECT reason, blocked_until, strikes FROM source_host_failures WHERE host = $1`, [host]);
      const p = rows[0];
      const prev: PrevBlock | null = p ? { reason: p.reason, blockedUntil: new Date(p.blocked_until), strikes: Number(p.strikes ?? 0) } : null;
      const next = nextBlock(prev, reason, t);
      const active = !!prev && prev.blockedUntil.getTime() > t.getTime();
      // A timeout inside a longer block (or a repeat inside one) keeps its reason and end; the row only notes the new attempt.
      await this.pool.query(
        `INSERT INTO source_host_failures (host, reason, status_code, first_at, last_at, blocked_until, strikes) VALUES ($1, $2, $3, $4, $4, $5, $6)
         ON CONFLICT (host) DO UPDATE SET
           reason = CASE WHEN $8 THEN source_host_failures.reason ELSE EXCLUDED.reason END,
           status_code = CASE WHEN $8 THEN source_host_failures.status_code ELSE EXCLUDED.status_code END,
           last_at = EXCLUDED.last_at,
           blocked_until = EXCLUDED.blocked_until,
           strikes = $6,
           failures = CASE WHEN $7 THEN source_host_failures.failures + 1 ELSE 1 END,
           first_at = CASE WHEN $7 THEN source_host_failures.first_at ELSE EXCLUDED.first_at END`,
        [host, reason, statusCode, t, next.until, next.strikes, active, next.keep],
      );
    } catch { /* never stops a fetch (e.g. before migration 094) */ }
  }

  /** A fetch of the host worked: the strikes start over and the next streak gets its own owner note. */
  async succeeded(host: string): Promise<void> {
    await this.pool.query(`UPDATE source_host_failures SET strikes = 0, noted_at = NULL WHERE host = $1 AND strikes > 0`, [host]).catch(() => {});
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
    if (kind && host) {
      await hosts?.record(host, kind);
      return { error: 'host_unreachable', details: `${host}: ${REASON_TEXT[kind]}. Не пробуй цей сайт сьогодні — інше джерело або пропусти слот.` };
    }
    // Spec 061 FR-004: a timeout is a failure too — a one-hour block, so the next ten calls do not wait ten seconds each.
    if (!kind && host && classifyTimeout(err)) {
      await hosts?.record(host, 'timeout');
      return { error: 'host_unreachable', details: `${host}: ${REASON_TEXT.timeout}. Година паузи для цього сайту — візьми інше джерело, snippet зі стрічки або пропусти слот.` };
    }
    throw err;
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
  if (host) await hosts?.succeeded?.(host);
  return res;
}

export const isFetchFailure = (v: unknown): v is FetchFailure => !!v && typeof v === 'object' && typeof (v as FetchFailure).error === 'string';
