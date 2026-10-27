// meta-insight-backoff.ts — spec 064 FR-010. A Graph insights metric that answers 400 "not supported / deprecated" is
// remembered per account for 7 days and not requested again (4 of 5 metrics failed every hour before). In-memory: a
// restart asks once more, which is cheap.
//
// Spec 070 FR-006: a 400 that does not say "unsupported" (a permission, an app mode, a parameter) was still asked again every
// hour, with only a debug line. Three 400s in a row on the same account and metric now back the metric off for a day (one
// request a day while it keeps failing, one warning a UTC day); one success starts the count again.
import { errText } from '../common/err-text';

export const METRIC_BACKOFF_MS = 7 * 86_400_000;
/** Spec 070 FR-006: consecutive plain 400s before the metric is backed off. */
export const REPEATED_400_LIMIT = 3;
/** Spec 070 FR-006: the back-off of a metric that keeps answering 400. */
export const REPEATED_400_BACKOFF_MS = 86_400_000;
/**
 * Graph codes that are not about this metric: 190 an expired token (the keeper and the collector handle it), and the
 * rate-limit / transient family 1, 2, 4, 17, 32, 613. They never count towards the three.
 */
export const UNCOUNTED_GRAPH_CODES: ReadonlySet<number> = new Set([190, 1, 2, 4, 17, 32, 613]);

const UNSUPPORTED = /not (be )?supported|unsupported|deprecat|no longer|invalid (insights )?metric|valid insights metric|must be one of|does not exist|nonexisting field/i;

/** Is this axios error a "this metric does not exist for this account/version" answer (HTTP 400), as opposed to a transient failure? */
export function isMetricUnsupported(err: any): boolean {
  const status = err?.response?.status ?? err?.status;
  if (status !== 400) return false;
  const e = err?.response?.data?.error;
  const text = `${e?.message ?? ''} ${e?.error_user_msg ?? ''} ${err?.message ?? ''}`;
  return e?.code === 100 || UNSUPPORTED.test(text);
}

/**
 * What a Graph error says, in one line for a log: `status 400 code=10/2108006 OAuthException: <message> (fbtrace_id X)`.
 * Spec 070 FR-006: the debug line used to print `Request failed with status code 400`, which hides why. The access token is
 * redacted (axios puts the whole request URL in some messages) and the line is at most 200 characters; the message is cut,
 * the fbtrace_id (what Meta support asks for) is kept. An error that is not a Graph answer prints `errText`.
 */
export function graphErrorText(err: any): string {
  const MAX = 200;
  const clean = (s: string) => s.replace(/access_token=[^&\s'"]+/gi, 'access_token=<REDACTED>').replace(/\s+/g, ' ').trim();
  const status = err?.response?.status ?? err?.status;
  const e = err?.response?.data?.error;
  if (!e || typeof e !== 'object') {
    const base = clean(errText(err));
    const text = status != null ? `status ${status} ${base}` : base;
    return text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text;
  }
  const code = e.code != null ? `${e.code}${e.error_subcode != null ? `/${e.error_subcode}` : ''}` : '?';
  const head = `status ${status ?? '?'} code=${code}${e.type ? ` ${e.type}` : ''}: `;
  const tail = e.fbtrace_id ? ` (fbtrace_id ${String(e.fbtrace_id).slice(0, 40)})` : '';
  const message = clean(String(e.message ?? e.error_user_msg ?? errText(err)));
  const room = Math.max(20, MAX - head.length - tail.length);
  return `${head}${message.length > room ? `${message.slice(0, room - 1)}…` : message}${tail}`;
}

export class MetaInsightBackoff {
  private readonly until = new Map<string, number>();
  private readonly loggedDay = new Map<string, string>();
  /** Consecutive plain 400s per account + metric (spec 070 FR-006). */
  private readonly strikes = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  private key(platform: string, targetId: string, metric: string): string { return `${platform}:${targetId}:${metric}`; }

  /** True while the metric is remembered as unsupported for this account. */
  skipped(platform: string, targetId: string, metric: string): boolean {
    const k = this.key(platform, targetId, metric);
    const t = this.until.get(k);
    if (t == null) return false;
    if (t <= this.now()) { this.until.delete(k); return false; }
    return true;
  }

  /** Remember the metric as unsupported. Returns true the first time per UTC day, so the caller logs once a day. */
  remember(platform: string, targetId: string, metric: string): boolean {
    const k = this.key(platform, targetId, metric);
    this.until.set(k, this.now() + METRIC_BACKOFF_MS);
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.loggedDay.get(k) === day) return false;
    this.loggedDay.set(k, day);
    return true;
  }

  /**
   * Spec 070 FR-006: a request for this metric failed. Only a 400 counts, and not the ones about the token or the rate
   * (UNCOUNTED_GRAPH_CODES); a 5xx or a network error leaves the count as it was. The third consecutive 400 sets a 24-hour
   * back-off, and every further 400 (one request a day, after it expired) sets it again. `log` is true once a UTC day, so
   * the caller warns once a day instead of once an hour.
   */
  failed(platform: string, targetId: string, metric: string, err: any): { count: number; backedOff: boolean; log: boolean } {
    const k = this.key(platform, targetId, metric);
    const count = this.strikes.get(k) ?? 0;
    const status = err?.response?.status ?? err?.status;
    const code = Number(err?.response?.data?.error?.code);
    if (status !== 400 || UNCOUNTED_GRAPH_CODES.has(code)) return { count, backedOff: false, log: false };
    const next = count + 1;
    this.strikes.set(k, next);
    if (next < REPEATED_400_LIMIT) return { count: next, backedOff: false, log: false };
    this.until.set(k, this.now() + REPEATED_400_BACKOFF_MS);
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.loggedDay.get(k) === day) return { count: next, backedOff: true, log: false };
    this.loggedDay.set(k, day);
    return { count: next, backedOff: true, log: true };
  }

  /** Spec 070 FR-006: the metric answered; the count of 400s starts again. */
  ok(platform: string, targetId: string, metric: string): void {
    const k = this.key(platform, targetId, metric);
    this.strikes.delete(k);
  }
}
