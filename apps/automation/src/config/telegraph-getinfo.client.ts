// apps/automation/src/config/telegraph-getinfo.client.ts
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface TelegraphAccountInfo {
  short_name:  string;
  author_name: string | null;
  author_url:  string | null;
  page_count?: number;
}

/**
 * Redact a Telegraph access token from any string. Telegraph tokens are long
 * hex strings (~60 chars); axios error messages can echo the request body /
 * URL, so we scrub anything that looks like one before it lands in
 * `telegraph_accounts.verify_error` (which is returned over the API).
 */
function redactToken(s: string): string {
  if (!s) return s;
  return s.replace(/\b[0-9a-f]{40,}\b/gi, '<REDACTED>');
}

/**
 * Thin client over the Telegraph API. Mirrors TelegramGetMeClient: a single
 * `getAccountInfo` verify call that confirms the token is alive and returns
 * the account's display metadata.
 */
@Injectable()
export class TelegraphGetInfoClient {
  private readonly logger = new Logger(TelegraphGetInfoClient.name);
  private static readonly BASE = 'https://api.telegra.ph';

  async getAccountInfo(token: string): Promise<TelegraphAccountInfo> {
    if (!token || token.length < 20) {
      throw new Error('Telegraph token looks malformed (too short)');
    }
    try {
      const res = await axios.get(`${TelegraphGetInfoClient.BASE}/getAccountInfo`, {
        params: {
          access_token: token,
          fields: JSON.stringify(['short_name', 'author_name', 'author_url', 'page_count']),
        },
        timeout: 8000,
      });
      const body = res.data;
      if (!body?.ok || !body.result) {
        throw new Error(`Telegraph API rejected: ${body?.error ?? 'unknown'}`);
      }
      return body.result as TelegraphAccountInfo;
    } catch (err: any) {
      const desc = err?.response?.data?.error ?? err.message ?? 'unknown';
      throw new Error(`getAccountInfo failed: ${redactToken(String(desc))}`);
    }
  }
}
