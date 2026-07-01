// apps/automation/src/config/meta-graph.client.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import type { MetaPlatform } from './meta-accounts.repository';
import { INSIGHT_METRICS, mergeInsightValues, parseMetricValues, type InsightKey, type MetaInsightDay, type DayValue } from './meta-insights';

export interface MetaVerifyResult {
  username:    string | null;
  displayName: string | null;
  followers:   number | null;
  pictureUrl:  string | null;
  /** The authoritative account id resolved from the token (Threads `/me`).
   *  Null for FB/IG, where the caller-supplied target id is queried directly.
   *  The caller persists this to self-heal a wrong/changed Threads target id. */
  resolvedTargetId: string | null;
}

/** Derived metadata from Graph `debug_token` — NEVER the token value itself. */
export interface MetaTokenInfo {
  type:                string | null;   // data.type, e.g. 'USER' | 'PAGE' | 'SYSTEM_USER'
  expiresAt:           Date | null;     // data.expires_at: unix secs; 0 → null (never)
  dataAccessExpiresAt: Date | null;     // data.data_access_expires_at: 0 → null
  scopes:              string[];        // data.scopes ?? []
  isValid:             boolean;         // data.is_valid ?? false
}

/** Unix epoch seconds → Date; 0/falsy/non-number → null (never-expires/unknown). */
function unixToDate(secs: unknown): Date | null {
  return typeof secs === 'number' && secs > 0 ? new Date(secs * 1000) : null;
}

/**
 * Strip the OAuth token from any string before it lands in verify_error /
 * the GET /api/meta-accounts response. Axios error messages embed the full
 * request URL (which contains `access_token=…`), so redact both the explicit
 * token value and the query param.
 */
function redactToken(s: string, token: string): string {
  if (!s) return s;
  let out = s.replace(/access_token=[^&\s'"]+/gi, 'access_token=<REDACTED>');
  if (token) out = out.split(token).join('<REDACTED>');
  return out;
}

@Injectable()
export class MetaGraphClient {
  private readonly logger = new Logger(MetaGraphClient.name);

  constructor(private readonly config: ConfigService) {}

  private get version(): string {
    return this.config.get<string>('META_GRAPH_VERSION') ?? 'v21.0';
  }

  /** Threads has its own Graph version line; it rejects Facebook's v21.0. */
  private get threadsVersion(): string {
    return this.config.get<string>('THREADS_GRAPH_VERSION') ?? 'v1.0';
  }

  private get timeout(): number {
    const n = parseInt(this.config.get<string>('FETCH_TIMEOUT') ?? '15000', 10);
    return Number.isFinite(n) ? n : 15000;
  }

  /**
   * Read-only confirmation that `token` can read `targetId`, returning the
   * display fields for the connection preview. Throws with a token-redacted
   * message on any failure.
   */
  async verify(platform: MetaPlatform, targetId: string, token: string): Promise<MetaVerifyResult> {
    if (!token) throw new Error('Token is empty');
    const isThreads = platform === 'threads';
    // FB/IG query the supplied node by id. Threads tokens are user-scoped, so we
    // query `/me` instead — the exact target id is irrelevant and is resolved
    // FROM the token (returned as resolvedTargetId), which self-heals a wrong or
    // stale Threads id. So a target id is only required for FB/IG.
    if (!isThreads && !targetId) throw new Error('Target id is empty');

    const base = isThreads ? 'https://graph.threads.net' : 'https://graph.facebook.com';
    const fields = isThreads
      ? ['id', 'username', 'name', 'threads_profile_picture_url']
      : platform === 'instagram'
        ? ['username', 'name', 'followers_count', 'profile_picture_url']
        // FB Pages: followers_count is the supported follower field (fan_count
        // was removed). picture{url} is dropped automatically below for node
        // types that don't expose it (e.g. a target id that is actually an IG
        // account), so a single deprecated/foreign field never fails verify.
        : ['name', 'username', 'followers_count', 'picture{url}'];

    const ver  = isThreads ? this.threadsVersion : this.version;
    const node = isThreads ? 'me' : encodeURIComponent(targetId);
    const url  = `${base}/${ver}/${node}`;
    try {
      const d = await this.fetchNodeFields(url, token, fields);
      return {
        username:        d.username ?? null,
        displayName:     d.name ?? d.username ?? null,
        followers:       typeof d.followers_count === 'number' ? d.followers_count : null,
        pictureUrl:      d.profile_picture_url ?? d.threads_profile_picture_url ?? d.picture?.data?.url ?? null,
        resolvedTargetId: isThreads && d.id != null ? String(d.id) : null,
      };
    } catch (err: any) {
      const desc = err?.response?.data?.error?.message ?? err?.message ?? 'unknown';
      throw new Error(`verify failed: ${redactToken(String(desc), token)}`);
    }
  }

  /**
   * GET a node's fields, tolerating Graph's `(#100) … nonexisting field (X)`
   * errors: the offending field is dropped and the request retried, so a node
   * type or token that doesn't expose one display field (e.g. `picture` on an
   * IG node, or a since-removed field) still returns whatever it CAN read
   * instead of failing the whole verify. Any non-`#100` error (bad token,
   * permissions, network) propagates unchanged. Bounded by the field count.
   */
  private async fetchNodeFields(url: string, token: string, fields: string[]): Promise<any> {
    let current = [...fields];
    for (let attempt = 0; attempt <= fields.length; attempt++) {
      try {
        const res = await axios.get(url, {
          params: { fields: current.join(','), access_token: token },
          timeout: this.timeout,
        });
        return res.data ?? {};
      } catch (err: any) {
        const desc = String(err?.response?.data?.error?.message ?? err?.message ?? '');
        const bad = /nonexisting field \(([^)]+)\)/i.exec(desc)?.[1];
        // Drop the rejected field (also its sub-field form, e.g. `picture{url}`)
        // and retry — but only if something readable would remain.
        const next = bad
          ? current.filter((f) => f !== bad && !f.startsWith(`${bad}{`) && !f.startsWith(`${bad}.`))
          : current;
        if (bad && next.length && next.length < current.length) { current = next; continue; }
        throw err;
      }
    }
    throw new Error('no readable fields');
  }

  /**
   * Self-inspect `token` via Graph `debug_token` and return its derived
   * metadata (type / expiry / scopes / validity) — NEVER the token value.
   * Best-effort: returns null on any error so Verify still succeeds. The token
   * is redacted from any logged error message. A facebook.com endpoint — only
   * call for facebook/instagram tokens (it rejects Threads tokens).
   */
  async inspectToken(token: string): Promise<MetaTokenInfo | null> {
    if (!token) return null;
    try {
      const res = await axios.get(`https://graph.facebook.com/${this.version}/debug_token`, {
        params: { input_token: token, access_token: token },
        timeout: this.timeout,
      });
      const d = res.data?.data ?? {};
      return {
        type:                typeof d.type === 'string' ? d.type : null,
        expiresAt:           unixToDate(d.expires_at),
        dataAccessExpiresAt: unixToDate(d.data_access_expires_at),
        scopes:              Array.isArray(d.scopes) ? d.scopes : [],
        isValid:             d.is_valid ?? false,
      };
    } catch (err: any) {
      this.logger.debug(`inspectToken failed: ${redactToken(String(err?.message ?? err), token)}`);
      return null;
    }
  }

  /**
   * Refresh a Threads long-lived token. Threads tokens last ~60 days and can be
   * refreshed with ONLY the current token (no app secret), via
   * graph.threads.net/refresh_access_token. Returns the NEW token plus its
   * lifetime in seconds. Throws a token-redacted error on failure — the token
   * never reaches a log or an error message in plaintext.
   */
  async refreshThreadsToken(token: string): Promise<{ accessToken: string; expiresInSec: number }> {
    if (!token) throw new Error('Token is empty');
    try {
      const res = await axios.get('https://graph.threads.net/refresh_access_token', {
        params: { grant_type: 'th_refresh_token', access_token: token },
        timeout: this.timeout,
      });
      const d = res.data ?? {};
      const accessToken = typeof d.access_token === 'string' ? d.access_token : '';
      if (!accessToken) throw new Error('refresh returned no access_token');
      const expiresInSec = typeof d.expires_in === 'number' ? d.expires_in : 0;
      return { accessToken, expiresInSec };
    } catch (err: any) {
      const desc = err?.response?.data?.error?.message ?? err?.message ?? 'unknown';
      throw new Error(`refreshThreadsToken failed: ${redactToken(String(desc), token)}`);
    }
  }

  /**
   * Daily account insights for the last `sinceDays`, normalized to
   * reach/impressions/profileViews. One Graph call per supported metric so a
   * single deprecated/unsupported metric degrades to null instead of 400-ing the
   * whole request. A failing metric is swallowed to null; account-level failures
   * are isolated by the caller (collector).
   */
  async fetchInsights(platform: MetaPlatform, targetId: string, token: string, sinceDays = 30): Promise<MetaInsightDay[]> {
    if (!token || !targetId) return [];
    const isThreads = platform === 'threads';
    const base = isThreads ? 'https://graph.threads.net' : 'https://graph.facebook.com';
    const ver  = isThreads ? this.threadsVersion : this.version;
    const edge = isThreads ? 'threads_insights' : 'insights';
    const until = Math.floor(Date.now() / 1000);
    const since = until - sinceDays * 86_400;

    const metrics = INSIGHT_METRICS[platform];
    const byMetric: Partial<Record<InsightKey, DayValue[]>> = {};
    for (const key of Object.keys(metrics) as (keyof typeof metrics)[]) {
      const metric = metrics[key]!;
      try {
        const res = await axios.get(`${base}/${ver}/${encodeURIComponent(targetId)}/${edge}`, {
          params: { metric, period: 'day', since, until, access_token: token },
          timeout: this.timeout,
        });
        byMetric[key] = parseMetricValues(res.data);
      } catch (err: any) {
        // metric unavailable on this platform/version → leave it null for all days.
        // Debug (not warn): this is expected degradation, but logging it lets us
        // tell "unsupported metric" apart from a transient error or a request bug.
        this.logger.debug(`fetchInsights: metric "${metric}" failed for ${platform}/${targetId}: ${redactToken(String(err?.message ?? err), token)}`);
      }
    }
    return mergeInsightValues(byMetric);
  }

  /**
   * Threads doesn't expose a follower count as a plain profile field (unlike
   * IG / FB `followers_count`), so `verify` returns null for it.
   * The count is available via the Threads insights API as a `total_value`
   * (a lifetime total, not a daily series), gated behind `threads_manage_insights`.
   * Returns null on any failure (e.g. scope not granted) — the caller keeps going.
   */
  async fetchThreadsFollowers(targetId: string, token: string): Promise<number | null> {
    if (!token || !targetId) return null;
    try {
      const res = await axios.get(`https://graph.threads.net/${this.threadsVersion}/${encodeURIComponent(targetId)}/threads_insights`, {
        params: { metric: 'followers_count', access_token: token },
        timeout: this.timeout,
      });
      const v = res.data?.data?.[0]?.total_value?.value;
      return typeof v === 'number' ? v : null;
    } catch (err: any) {
      this.logger.debug(`fetchThreadsFollowers failed for ${targetId}: ${redactToken(String(err?.message ?? err), token)}`);
      return null;
    }
  }
}
