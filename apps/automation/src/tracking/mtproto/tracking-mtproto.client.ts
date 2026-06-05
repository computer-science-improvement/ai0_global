import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramClient, Api } from 'telegram';
import { StringSession }       from 'telegram/sessions';

export interface FullChannelResult {
  tgChatId:    string;
  username:    string | null;
  title:       string | null;
  about:       string | null;
  subsCount:   number | null;
}

export interface RawMessage {
  id:                  number;
  date:                Date;
  text:                string;
  hasMedia:            boolean;
  mediaType:           'photo' | 'video' | 'document' | null;
  views:               number | null;
  forwards:            number | null;
  replies:             number | null;
  reactionsTotal:      number;
  reactions:           Record<string, number> | null;
  entities:            { type: string; offset: number; length: number; url?: string }[];
  forwardFromUsername: string | null;
}

export interface ResolveResult {
  tgChatId:  string;
  username:  string;
  title:     string | null;
  isClosed:  boolean;
}

/** Channel-shaped peek of an invite link via messages.checkChatInvite.
 *  Does NOT require the session to be a member of the channel. */
export interface InviteCheckResult {
  /** When the session is already a member, this is the real -100… chat
   *  id; when not joined yet (the common case), it's null and the channel
   *  is identified only by the hash. */
  tgChatId:   string | null;
  title:      string | null;
  subsCount:  number | null;
  /** True for channels (broadcast / megagroup), false for basic groups. */
  isChannel:  boolean;
  /** True when MTProto returned ChatInviteAlready — we already joined. */
  alreadyJoined: boolean;
}

const FLOOD_WAIT_RE = /A wait of (\d+) seconds is required/;

@Injectable()
export class TrackingMtprotoClient implements OnModuleInit {
  private readonly logger = new Logger(TrackingMtprotoClient.name);
  private client: TelegramClient | null = null;
  private ready  = false;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const apiId   = parseInt(this.config.get<string>('TELEGRAM_API_ID') ?? '', 10);
    const apiHash = this.config.get<string>('TELEGRAM_API_HASH') ?? '';
    const dedicated = this.config.get<string>('TELEGRAM_TRACKING_SESSION_STRING') ?? '';
    const shared    = this.config.get<string>('TELEGRAM_TRACKING_SHARE_SESSION') === 'true'
      ? (this.config.get<string>('TELEGRAM_SESSION_STRING') ?? '')
      : '';
    const session = dedicated || shared;

    if (!apiId || !apiHash || !session) {
      this.logger.warn(
        'TrackingMtprotoClient disabled: set TELEGRAM_TRACKING_SESSION_STRING ' +
        '(or TELEGRAM_TRACKING_SHARE_SESSION=true to reuse the stats session)',
      );
      return;
    }

    this.client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 2 });
    try {
      await this.client.connect();
      this.ready = true;
      this.logger.log('TrackingMtprotoClient ready');
    } catch (err: any) {
      this.ready = false;
      this.logger.warn(`TrackingMtprotoClient connect failed: ${err.errorMessage ?? err.message ?? err}`);
      try { await this.client.disconnect(); } catch { /* ignore */ }
      this.client = null;
    }
  }

  isEnabled(): boolean { return this.ready; }

  /**
   * Convert the caller's address into something gramjs's getEntity accepts.
   *   - private chat ids (`-1003984251759`) → numeric (gramjs handles the
   *     bot-API ↔ MTProto id translation internally when given a number;
   *     given a string starting with '-100' it tries to resolve as a
   *     username and fails)
   *   - @usernames and bare usernames → passed through as strings
   *
   * Returns null when the address looks like a too-large numeric id that
   * doesn't fit in a JS Number (channel ids are ~1e12, safely under 2^53).
   */
  private toAddress(usernameOrId: string): string | number | null {
    if (usernameOrId.startsWith('-')) {
      const n = Number(usernameOrId);
      return Number.isSafeInteger(n) ? n : null;
    }
    return usernameOrId;
  }

  async getFullChannel(usernameOrId: string): Promise<FullChannelResult | 'not_subscribed' | null> {
    if (!this.ready || !this.client) return null;
    const address = this.toAddress(usernameOrId);
    if (address === null) return null;
    try {
      const entity = await this.client.getEntity(address as any);
      const full = await this.client.invoke(new Api.channels.GetFullChannel({ channel: entity as any }));
      const fc   = (full as any).fullChat;
      const ch   = (full as any).chats?.find((c: any) => String(c.id) === String((entity as any).id));
      return {
        tgChatId:  String((entity as any).id),
        username:  ch?.username ?? null,
        title:     ch?.title ?? null,
        about:     fc?.about ?? null,
        subsCount: fc?.participantsCount ?? null,
      };
    } catch (err: any) {
      const notSub = err?.errorMessage === 'CHANNEL_INVALID'
        || /could not find the input entity/i.test(String(err?.message ?? ''));
      if (notSub) {
        this.logger.debug(`getFullChannel: ${usernameOrId} not reachable by session (not subscribed)`);
        return 'not_subscribed';
      }
      this.handleApiError('getFullChannel', err);
      return null;
    }
  }

  async getHistory(usernameOrId: string, offsetId: number, limit = 50): Promise<RawMessage[]> {
    if (!this.ready || !this.client) return [];
    const address = this.toAddress(usernameOrId);
    if (address === null) return [];
    try {
      const entity = await this.client.getEntity(address as any);
      const res    = await this.client.invoke(
        new Api.messages.GetHistory({ peer: entity as any, limit, minId: offsetId, offsetId: 0 }),
      );
      const msgs   = (res as any).messages as any[];
      return msgs
        .filter((m) => m.className === 'Message')
        .map((m) => this.toRawMessage(m));
    } catch (err: any) {
      this.handleApiError('getHistory', err);
      return [];
    }
  }

  /**
   * Peek a private channel via its invite-link hash, WITHOUT joining.
   * Telegram's messages.checkChatInvite returns one of three shapes:
   *
   *   - ChatInvite          — not joined; carries title / photo / participants
   *                           but no resolvable chat id
   *   - ChatInviteAlready   — already a member; wraps the actual Chat object
   *                           with the real -100… id
   *   - ChatInvitePeek      — peek granted for a limited time (rare)
   *
   * We normalize all three into InviteCheckResult. Hash is the part after
   * `t.me/+` (or `t.me/joinchat/`). FLOOD_WAIT is re-thrown so BullMQ
   * delays the job rather than losing it.
   */
  async checkInvite(hash: string): Promise<InviteCheckResult | null> {
    if (!this.ready || !this.client) return null;
    try {
      const res: any = await this.client.invoke(
        new Api.messages.CheckChatInvite({ hash }),
      );
      const cls = res?.className;

      if (cls === 'ChatInvite') {
        // Not joined — channel is identified only by the hash for now.
        // photo / participantsCount / title come from the preview.
        return {
          tgChatId:      null,
          title:         res.title ?? null,
          subsCount:     typeof res.participantsCount === 'number' ? res.participantsCount : null,
          isChannel:     !!res.channel || !!res.broadcast || !!res.megagroup,
          alreadyJoined: false,
        };
      }

      if (cls === 'ChatInviteAlready' || cls === 'ChatInvitePeek') {
        // Already a member (or peek granted) — res.chat is the Chat object.
        const chat: any = res.chat ?? {};
        return {
          tgChatId:      chat.id ? String(chat.id) : null,
          title:         chat.title ?? null,
          subsCount:     typeof chat.participantsCount === 'number' ? chat.participantsCount : null,
          isChannel:     !!chat.broadcast || !!chat.megagroup || chat.className === 'Channel',
          alreadyJoined: cls === 'ChatInviteAlready',
        };
      }

      this.logger.warn(`checkInvite: unexpected response className ${cls}`);
      return null;
    } catch (err: any) {
      const msg = err.errorMessage ?? err.message ?? '';
      if (/INVITE_HASH_(INVALID|EXPIRED|EMPTY)/.test(msg)) {
        this.logger.debug(`checkInvite: ${hash} ${msg}`);
        return null;
      }
      this.handleApiError('checkInvite', err);
      return null;
    }
  }

  async resolveUsername(username: string): Promise<ResolveResult | null> {
    if (!this.ready || !this.client) return null;
    try {
      const res = await this.client.invoke(new Api.contacts.ResolveUsername({ username }));
      const ch  = (res as any).chats?.[0];
      if (!ch) return null;
      return {
        tgChatId: String(ch.id),
        username: ch.username ?? username,
        title:    ch.title ?? null,
        isClosed: !!ch.restricted || ch.access_hash === null,
      };
    } catch (err: any) {
      const msg = err.errorMessage ?? err.message ?? '';
      if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID/.test(msg)) {
        this.logger.debug(`ResolveUsername: ${username} not found`);
        return null;
      }
      if (/CHANNEL_PRIVATE/.test(msg)) {
        return { tgChatId: '', username, title: null, isClosed: true };
      }
      this.handleApiError('resolveUsername', err);
      return null;
    }
  }

  private toRawMessage(m: any): RawMessage {
    const reactions: Record<string, number> = {};
    let reactionsTotal = 0;
    for (const r of m.reactions?.results ?? []) {
      const key = r.reaction?.emoticon ?? r.reaction?.documentId?.toString() ?? '?';
      reactions[key] = r.count;
      reactionsTotal += r.count;
    }
    return {
      id:                  m.id,
      date:                new Date(m.date * 1000),
      text:                m.message ?? '',
      hasMedia:            !!m.media,
      mediaType:           m.media?.className?.replace(/^MessageMedia/, '').toLowerCase() ?? null,
      views:               m.views ?? null,
      forwards:            m.forwards ?? null,
      replies:             m.replies?.replies ?? null,
      reactionsTotal,
      reactions:           Object.keys(reactions).length ? reactions : null,
      entities:            (m.entities ?? []).map((e: any) => ({
        type:   (e.className ?? '').replace(/^MessageEntity/, '').toLowerCase(),
        offset: e.offset, length: e.length, url: e.url,
      })),
      forwardFromUsername: m.fwdFrom?.fromName ?? null,
    };
  }

  /** Logs the error and re-throws FLOOD_WAIT so BullMQ can delay the job. */
  private handleApiError(where: string, err: any): void {
    const msg = err.errorMessage ?? err.message ?? '';
    const flood = FLOOD_WAIT_RE.exec(msg);
    if (flood) {
      this.logger.warn(`${where}: FLOOD_WAIT ${flood[1]}s`);
      const ts = parseInt(flood[1], 10);
      const e: any = new Error(`FLOOD_WAIT ${ts}`);
      e.floodWaitSeconds = ts;
      throw e;
    }
    this.logger.warn(`${where} failed: ${msg}`);
  }
}
