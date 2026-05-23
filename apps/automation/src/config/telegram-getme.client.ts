// apps/automation/src/config/telegram-getme.client.ts
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface TelegramGetMeResult {
  id:         number;
  is_bot:     boolean;
  first_name: string;
  username:   string;
}

/**
 * Replace any `bot<TOKEN>` substring in error messages / URLs with
 * `bot<REDACTED>`. Axios's default error messages (especially on
 * ECONNREFUSED / ETIMEDOUT) include the full request URL — without this,
 * the bot token would land in `my_bots.verify_error` and surface via the
 * GET /api/my-bots response.
 */
function redactToken(s: string): string {
  if (!s) return s;
  // Telegram tokens: `<bot_id>:<35-char-secret>`. Match `bot<anything-not-slash>`.
  return s.replace(/bot[A-Za-z0-9_:-]{20,}/g, 'bot<REDACTED>');
}

@Injectable()
export class TelegramGetMeClient {
  private readonly logger = new Logger(TelegramGetMeClient.name);

  /** Returns getMe result or throws with a sanitized human message. */
  async getMe(token: string): Promise<TelegramGetMeResult> {
    // Real tokens are `<digits>:<35-char-secret>` ~= 46 chars. 30 was too loose.
    if (!token || token.length < 40 || !token.includes(':')) {
      throw new Error('Token looks malformed (expected `<id>:<secret>`)');
    }
    try {
      const res = await axios.get(
        `https://api.telegram.org/bot${token}/getMe`,
        { timeout: 8000 },
      );
      const body = res.data;
      if (!body?.ok || !body.result) {
        throw new Error(`Telegram API rejected: ${body?.description ?? 'unknown'}`);
      }
      return body.result;
    } catch (err: any) {
      const desc = err?.response?.data?.description ?? err.message ?? 'unknown';
      // Always redact — `desc` may originate from axios URL-in-message paths.
      throw new Error(`getMe failed: ${redactToken(String(desc))}`);
    }
  }
}
