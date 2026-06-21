import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { LogLevel } from 'telegram/extensions/Logger';
import { MtprotoSessionsRepository } from '../config/mtproto-sessions.repository';
import { SecretsService } from '../common/crypto/secrets.service';
import { withTimeout } from '../common/with-timeout';
import type { ChatMessage, JoinedGroup, RawDm } from './agent.types';

const FLOOD_WAIT_RE = /A wait of (\d+) seconds is required/;

@Injectable()
export class AgentMtprotoClient {
  private readonly logger = new Logger(AgentMtprotoClient.name);

  constructor(
    private readonly sessions: MtprotoSessionsRepository,
    private readonly secrets:  SecretsService,
    private readonly config:   ConfigService,
  ) {}

  /** True when an active role='agent' session exists. */
  async hasSession(): Promise<boolean> {
    return (await this.sessions.activeSession(this.secrets, 'agent')) != null;
  }

  /**
   * Fetch the latest message of each recent 1:1 DM dialog. Read-only: this class
   * exposes NO send methods by design. Returns [] (and logs) when no agent
   * session, on FLOOD_WAIT, or on any error — the poller treats [] as "nothing".
   */
  async fetchRecentDialogs(limit = 50): Promise<RawDm[]> {
    const active = await this.sessions.activeSession(this.secrets, 'agent');
    if (!active) return [];
    const apiId   = active.apiId  ?? Number(this.config.get('TELEGRAM_API_ID'));
    const apiHash = active.apiHash ?? this.config.get<string>('TELEGRAM_API_HASH') ?? '';
    if (!apiId || !apiHash) { this.logger.warn('agent: missing api credentials'); return []; }

    const client = new TelegramClient(new StringSession(active.session), apiId, apiHash, { connectionRetries: 2 });
    client.setLogLevel(LogLevel.NONE);
    try {
      await client.connect();
      const dialogs = await withTimeout(client.getDialogs({ limit }), 15_000, 'agent getDialogs');
      const out: RawDm[] = [];
      for (const d of dialogs) {
        if (!d.isUser) continue;                 // 1:1 DMs only (no channels/groups)
        const m: any = d.message;
        if (!m || !m.id) continue;
        const ent: any = d.entity;
        out.push({
          peerId:       String(ent?.id ?? d.id),
          peerUsername: ent?.username ?? null,
          peerName:     [ent?.firstName, ent?.lastName].filter(Boolean).join(' ') || null,
          messageId:    Number(m.id),
          text:         typeof m.message === 'string' ? m.message : '',
          date:         m.date ? new Date(m.date * 1000) : new Date(),
          out:          !!m.out,
        });
      }
      return out;
    } catch (err: any) {
      const msg = err?.errorMessage ?? err?.message ?? String(err);
      if (FLOOD_WAIT_RE.test(msg)) this.logger.warn(`agent: FLOOD_WAIT — backing off`);
      else this.logger.warn(`agent fetchRecentDialogs failed: ${msg}`);
      return [];
    } finally {
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  }

  /**
   * Joined GROUP/megagroup dialogs (for the monitoring allow-list). No DMs. No join.
   * Read-only: enumerates already-joined membership only.
   */
  async listGroups(limit = 100): Promise<JoinedGroup[]> {
    const active = await this.sessions.activeSession(this.secrets, 'agent');
    if (!active) return [];
    const apiId   = active.apiId  ?? Number(this.config.get('TELEGRAM_API_ID'));
    const apiHash = active.apiHash ?? this.config.get<string>('TELEGRAM_API_HASH') ?? '';
    if (!apiId || !apiHash) { this.logger.warn('agent: missing api credentials'); return []; }

    const client = new TelegramClient(new StringSession(active.session), apiId, apiHash, { connectionRetries: 2 });
    client.setLogLevel(LogLevel.NONE);
    try {
      await client.connect();
      const dialogs = await withTimeout(client.getDialogs({ limit }), 15_000, 'agent listGroups');
      const out: JoinedGroup[] = [];
      for (const d of dialogs as any[]) {
        if (!(d.isGroup || d.isChannel) || d.isUser) continue;
        const ent: any = d.entity;
        out.push({ chatId: String(ent?.id ?? d.id), title: d.title ?? ent?.title ?? String(d.id) });
      }
      return out;
    } catch (err: any) {
      const msg = err?.errorMessage ?? err?.message ?? String(err);
      if (FLOOD_WAIT_RE.test(msg)) this.logger.warn(`agent: FLOOD_WAIT — backing off`);
      else this.logger.warn(`agent listGroups failed: ${msg}`);
      return [];
    } finally {
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  }

  /**
   * New messages in a chat since minId (read-only).
   * No join, no send — pure history fetch on already-joined chats.
   */
  async fetchChatMessages(chatId: string, minId: number, limit = 50): Promise<ChatMessage[]> {
    const active = await this.sessions.activeSession(this.secrets, 'agent');
    if (!active) return [];
    const apiId   = active.apiId  ?? Number(this.config.get('TELEGRAM_API_ID'));
    const apiHash = active.apiHash ?? this.config.get<string>('TELEGRAM_API_HASH') ?? '';
    if (!apiId || !apiHash) { this.logger.warn('agent: missing api credentials'); return []; }

    const client = new TelegramClient(new StringSession(active.session), apiId, apiHash, { connectionRetries: 2 });
    client.setLogLevel(LogLevel.NONE);
    try {
      await client.connect();
      const entity = await client.getEntity(chatId);
      const res: any = await withTimeout(
        client.invoke(new Api.messages.GetHistory({ peer: entity as any, limit, minId, offsetId: 0 })),
        15_000, 'agent fetchChatMessages',
      );
      const msgs: any[] = res?.messages ?? [];
      return msgs
        .filter(m => m && m.id && typeof m.message === 'string')
        .map(m => ({ messageId: Number(m.id), text: String(m.message), date: m.date ? new Date(m.date * 1000) : new Date() }));
    } catch (err: any) {
      const msg = err?.errorMessage ?? err?.message ?? String(err);
      if (FLOOD_WAIT_RE.test(msg)) this.logger.warn(`agent: FLOOD_WAIT — backing off`);
      else this.logger.warn(`agent fetchChatMessages failed: ${msg}`);
      return [];
    } finally {
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  }
}
