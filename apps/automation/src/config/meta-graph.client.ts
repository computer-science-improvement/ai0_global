// apps/automation/src/config/meta-graph.client.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import type { MetaPlatform } from './meta-accounts.repository';

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
  constructor(private readonly config: ConfigService) {}

  private get version(): string {
    return this.config.get<string>('META_GRAPH_VERSION') ?? 'v21.0';
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

    const url = `${base}/${this.version}/${encodeURIComponent(targetId)}`;
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
}
