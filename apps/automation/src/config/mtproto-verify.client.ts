// apps/automation/src/config/mtproto-verify.client.ts
//
// User-triggered live verification of an MTProto session string. Connects via
// gramjs with the app-level apiId/apiHash (from env) and calls getMe() to prove
// the session is valid and capture the display identity (username / phone /
// user id). This is the ONLY place a stored session string is sent over the
// network, and only when an operator clicks "Verify". The session string is
// never logged; errors are returned as plain messages (gramjs RPC errors carry
// no secret material, but we still avoid echoing the session).
//
// Isolated as its own injectable so the controller's tests can mock it without
// any network access (and so the heavy gramjs connect path is testable).
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { LogLevel } from 'telegram/extensions/Logger';

export interface MtprotoVerifyResult {
  username:  string | null;
  phone:     string | null;
  tgUserId:  string | null;
}

@Injectable()
export class MtprotoVerifyClient {
  private readonly logger = new Logger(MtprotoVerifyClient.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Connect with the given plaintext session and return the account identity.
   * Throws with a sanitized message on failure (missing creds, bad session,
   * connect/getMe error). The session string is never included in the message.
   */
  async verify(session: string): Promise<MtprotoVerifyResult> {
    const apiId   = parseInt(this.config.get<string>('TELEGRAM_API_ID') ?? '', 10);
    const apiHash = this.config.get<string>('TELEGRAM_API_HASH') ?? '';
    if (!apiId || !apiHash) {
      throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH not set — cannot verify session');
    }

    const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
      connectionRetries: 2,
    });
    try { client.setLogLevel(LogLevel.NONE); } catch { /* ignore logger API mismatch */ }

    try {
      await client.connect();
      const me: any = await client.getMe();
      if (!me) throw new Error('getMe returned no account');
      return {
        username: me.username ?? null,
        phone:    me.phone ? String(me.phone) : null,
        tgUserId: me.id != null ? String(me.id) : null,
      };
    } catch (err: any) {
      // gramjs RPC errors expose errorMessage; never echo the session.
      const msg = err?.errorMessage ?? err?.message ?? 'unknown error';
      throw new Error(String(msg));
    } finally {
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  }
}
