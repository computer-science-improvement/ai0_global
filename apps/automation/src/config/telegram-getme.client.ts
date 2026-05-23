// apps/automation/src/config/telegram-getme.client.ts
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface TelegramGetMeResult {
  id:         number;
  is_bot:     boolean;
  first_name: string;
  username:   string;
}

@Injectable()
export class TelegramGetMeClient {
  private readonly logger = new Logger(TelegramGetMeClient.name);

  /** Returns getMe result or throws with a human message. */
  async getMe(token: string): Promise<TelegramGetMeResult> {
    if (!token || token.length < 30) {
      throw new Error('Token looks malformed (too short)');
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
      const desc = err?.response?.data?.description ?? err.message;
      throw new Error(`getMe failed: ${desc}`);
    }
  }
}
