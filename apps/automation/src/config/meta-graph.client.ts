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
    if (!targetId) throw new Error('Target id is empty');

    const base = platform === 'threads' ? 'https://graph.threads.net' : 'https://graph.facebook.com';
    const fields = platform === 'threads'
      ? 'username,name,threads_profile_picture_url'
      : platform === 'instagram'
        ? 'username,name,followers_count,profile_picture_url'
        : 'name,username,followers_count,fan_count,picture{url}';

    const ver = platform === 'threads' ? this.threadsVersion : this.version;
    const url = `${base}/${ver}/${encodeURIComponent(targetId)}`;
    try {
      const res = await axios.get(url, {
        params: { fields, access_token: token },
        timeout: this.timeout,
      });
      const d = res.data ?? {};
      return {
        username:    d.username ?? null,
        displayName: d.name ?? d.username ?? null,
        followers:   typeof d.followers_count === 'number' ? d.followers_count
                   : typeof d.fan_count === 'number' ? d.fan_count
                   : null,
        pictureUrl:  d.profile_picture_url ?? d.threads_profile_picture_url ?? d.picture?.data?.url ?? null,
      };
    } catch (err: any) {
      const desc = err?.response?.data?.error?.message ?? err?.message ?? 'unknown';
      throw new Error(`verify failed: ${redactToken(String(desc), token)}`);
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
   * IG `followers_count` / FB `fan_count`), so `verify` returns null for it.
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
