import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { LogLevel } from 'telegram/extensions/Logger';
import { MtprotoSessionsRepository } from '../config/mtproto-sessions.repository';
import { SecretsService } from '../common/crypto/secrets.service';
import { withTimeout } from '../common/with-timeout';

/**
 * The ONLY component in the agent module that SENDS a Telegram message. Used
 * exclusively from the approve path (AgentActionsService) — never the poller,
 * never autonomously. Sends a DM reply from the agent (role='agent') account.
 */
@Injectable()
export class AgentReplySender {
  private readonly logger = new Logger(AgentReplySender.name);

  constructor(
    private readonly sessions: MtprotoSessionsRepository,
    private readonly secrets:  SecretsService,
    private readonly config:   ConfigService,
  ) {}

  async sendReply(peerId: string, peerUsername: string | null, text: string): Promise<{ ok: boolean; error?: string }> {
    if (!text?.trim()) return { ok: false, error: 'empty text' };
    const active = await this.sessions.activeSession(this.secrets, 'agent');
    if (!active) return { ok: false, error: 'no active agent session' };
    const apiId   = active.apiId  ?? Number(this.config.get('TELEGRAM_API_ID'));
    const apiHash = active.apiHash ?? this.config.get<string>('TELEGRAM_API_HASH') ?? '';
    if (!apiId || !apiHash) return { ok: false, error: 'missing api credentials' };

    const client = new TelegramClient(new StringSession(active.session), apiId, apiHash, { connectionRetries: 2 });
    client.setLogLevel(LogLevel.NONE);
    try {
      await client.connect();
      // Prefer username when present; fall back to numeric id.
      const target: any = peerUsername ? peerUsername : await client.getEntity(peerId);
      await withTimeout(client.sendMessage(target, { message: text }), 15_000, 'agent sendReply');
      return { ok: true };
    } catch (err: any) {
      const msg = err?.errorMessage ?? err?.message ?? String(err);
      this.logger.warn(`agent sendReply failed: ${msg}`);
      return { ok: false, error: msg };
    } finally {
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  }
}
