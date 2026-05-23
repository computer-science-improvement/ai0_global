import { Injectable, Logger } from '@nestjs/common';

export interface TelegramGetMeResult {
  botId:     string;
  username:  string | null;
  firstName: string | null;
}

interface TelegramGetMeResponse {
  ok:           boolean;
  result?:      {
    id:         number;
    is_bot:     boolean;
    first_name: string;
    username?:  string;
  };
  description?: string;
  error_code?:  number;
}

@Injectable()
export class TelegramGetMeClient {
  private readonly logger = new Logger(TelegramGetMeClient.name);

  async getMe(token: string): Promise<TelegramGetMeResult> {
    if (!token || typeof token !== 'string') {
      throw new Error('Telegram getMe failed: token is empty');
    }

    const url = `https://api.telegram.org/bot${token}/getMe`;

    let res: Response;
    try {
      res = await fetch(url);
    } catch (e: any) {
      throw new Error(`Telegram getMe network error: ${e?.message ?? String(e)}`);
    }

    let body: TelegramGetMeResponse | null = null;
    try {
      body = (await res.json()) as TelegramGetMeResponse;
    } catch (e: any) {
      throw new Error(
        `Telegram getMe non-JSON response (HTTP ${res.status}): ${e?.message ?? String(e)}`,
      );
    }

    if (!res.ok || !body?.ok || !body.result) {
      const desc = body?.description ?? `HTTP ${res.status}`;
      const code = body?.error_code !== undefined ? ` [code=${body.error_code}]` : '';
      throw new Error(`Telegram getMe failed: ${desc}${code}`);
    }

    if (!body.result.is_bot) {
      throw new Error('Telegram getMe failed: token does not belong to a bot');
    }

    return {
      botId:     String(body.result.id),
      username:  body.result.username ?? null,
      firstName: body.result.first_name ?? null,
    };
  }
}
