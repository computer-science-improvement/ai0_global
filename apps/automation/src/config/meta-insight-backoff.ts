// meta-insight-backoff.ts — spec 064 FR-010. A Graph insights metric that answers 400 "not supported / deprecated" is
// remembered per account for 7 days and not requested again (4 of 5 metrics failed every hour before). In-memory: a
// restart asks once more, which is cheap.

export const METRIC_BACKOFF_MS = 7 * 86_400_000;

const UNSUPPORTED = /not (be )?supported|unsupported|deprecat|no longer|invalid (insights )?metric|valid insights metric|must be one of|does not exist|nonexisting field/i;

/** Is this axios error a "this metric does not exist for this account/version" answer (HTTP 400), as opposed to a transient failure? */
export function isMetricUnsupported(err: any): boolean {
  const status = err?.response?.status ?? err?.status;
  if (status !== 400) return false;
  const e = err?.response?.data?.error;
  const text = `${e?.message ?? ''} ${e?.error_user_msg ?? ''} ${err?.message ?? ''}`;
  return e?.code === 100 || UNSUPPORTED.test(text);
}

export class MetaInsightBackoff {
  private readonly until = new Map<string, number>();
  private readonly loggedDay = new Map<string, string>();

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
}
