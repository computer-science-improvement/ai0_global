import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SettingsService } from '../../settings/settings.service';
import { TelegramClient, Api } from 'telegram';
import { StringSession }       from 'telegram/sessions';
import { LogLevel }            from 'telegram/extensions/Logger';
import { withTimeout }         from '../../common/with-timeout';

export interface TgAccountInfo {
  id:        string | null;
  username:  string | null;
  firstName: string | null;
  lastName:  string | null;
  phone:     string | null;
  isPremium: boolean;
}

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
  /** Epoch ms of the last getDialogs() cache-warm; throttles re-warming. */
  private dialogsWarmedAt = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Wait for DB overrides so a dashboard-set TELEGRAM_TRACKING_SHARE_SESSION
    // wins over .env on this (restart-time) read.
    await this.settings.whenLoaded();
    const apiId   = parseInt(this.config.get<string>('TELEGRAM_API_ID') ?? '', 10);
    const apiHash = this.config.get<string>('TELEGRAM_API_HASH') ?? '';
    const dedicated = this.config.get<string>('TELEGRAM_TRACKING_SESSION_STRING') ?? '';
    const shared    = this.settings.trackingShareSession()
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
    // GramJS prints raw `RPCError: 400: CHANNEL_INVALID` stack blocks via its own
    // logger; our handleApiError already logs concise messages, so silence GramJS.
    try { this.client.setLogLevel(LogLevel.NONE); } catch { /* ignore logger API mismatch */ }
    try {
      await this.client.connect();
      this.ready = true;
      this.logger.log('TrackingMtprotoClient ready');
      // Warm the session entity cache so getEntity(channelId) can resolve
      // subscribed channels by their numeric id (gramjs needs the cached
      // access_hash, which only dialogs provide).
      await this.warmDialogs(true);
    } catch (err: any) {
      this.ready = false;
      this.logger.warn(`TrackingMtprotoClient connect failed: ${err.errorMessage ?? err.message ?? err}`);
      try { await this.client.disconnect(); } catch { /* ignore */ }
      this.client = null;
    }
  }

  isEnabled(): boolean { return this.ready; }

  private cachedMe: TgAccountInfo | null = null;

  /**
   * Account behind the session — the real Telegram user the tracker logs in
   * as. Fetched once via getMe() and cached. Returns null when the session
   * is empty / not connected. Lets the Connections UI show "who" the session
   * belongs to (username / name / phone) rather than just a connected flag.
   */
  async getAccount(): Promise<TgAccountInfo | null> {
    if (!this.ready || !this.client) return null;
    if (this.cachedMe) return this.cachedMe;
    try {
      // Bound the call: a "ready" session whose socket has silently died makes
      // getMe() hang forever, which would hang GET /tracking/session and leave
      // the Connections "Sessions" panel stuck on "Loading…". On timeout we
      // fall through to the catch and return null (account identity omitted),
      // while the synchronous getStatus() still drives the panel.
      const me: any = await withTimeout(this.client.getMe(), 8000, 'tracking getMe');
      if (!me) return null;
      this.cachedMe = {
        id:        me.id != null ? String(me.id) : null,
        username:  me.username  ?? null,
        firstName: me.firstName ?? null,
        lastName:  me.lastName  ?? null,
        phone:     me.phone     ?? null,
        isPremium: !!me.premium,
      };
      return this.cachedMe;
    } catch (err: any) {
      this.logger.debug(`getAccount (getMe) failed: ${err?.errorMessage ?? err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Read-only snapshot of the tracking session for the Connections UI. Never
   * leaks the session string itself — only whether it's configured, which env
   * var holds it, and whether the client connected.
   */
  getStatus(): {
    configured:  boolean;
    ready:       boolean;
    hasApiCreds: boolean;
    envVar:      string;
    shared:      boolean;
  } {
    const apiId     = this.config.get<string>('TELEGRAM_API_ID') ?? '';
    const apiHash   = this.config.get<string>('TELEGRAM_API_HASH') ?? '';
    const dedicated = this.config.get<string>('TELEGRAM_TRACKING_SESSION_STRING') ?? '';
    const shareOn   = this.settings.trackingShareSession();
    const shared    = shareOn ? (this.config.get<string>('TELEGRAM_SESSION_STRING') ?? '') : '';
    const hasApiCreds = !!apiId && !!apiHash;
    const hasSession  = !!(dedicated || shared);
    return {
      configured:  hasApiCreds && hasSession,
      ready:       this.ready,
      hasApiCreds,
      envVar:      dedicated ? 'TELEGRAM_TRACKING_SESSION_STRING' : 'TELEGRAM_SESSION_STRING',
      shared:      !dedicated && !!shared,
    };
  }

  /**
   * Convert the caller's address into something gramjs's getEntity accepts.
   *   - bot-API chat ids (`-1003984251759`) → numeric (gramjs handles the
   *     bot-API ↔ MTProto id translation internally when given a number;
   *     given a string starting with '-100' it tries to resolve as a
   *     username and fails)
   *   - raw channel ids (`1413275904`, all-digits, positive) → marked into
   *     bot-API form `-100…` so gramjs treats them as a channel peer rather
   *     than a user/contact id. (Telegram usernames must start with a
   *     letter, so an all-digit address is always a numeric id.)
   *   - @usernames and bare usernames → passed through as strings
   *
   * Returns null when the address doesn't fit in a JS Number safely
   * (channel ids are ~1e12, safely under 2^53 even after the -100 marker).
   */
  private toAddress(usernameOrId: string): string | number | null {
    if (usernameOrId.startsWith('-')) {
      const n = Number(usernameOrId);
      return Number.isSafeInteger(n) ? n : null;
    }
    if (/^\d+$/.test(usernameOrId)) {
      // Raw channel id → bot-API marked id so getEntity resolves it as a
      // channel peer using the cached access_hash.
      const n = Number(`-100${usernameOrId}`);
      return Number.isSafeInteger(n) ? n : null;
    }
    return usernameOrId;
  }

  /** True for the gramjs/Telegram errors that mean "this session can't see
   *  this channel" — either it was never cached or the account isn't a
   *  member. Distinct from transient/flood errors. */
  private isEntityMiss(err: any): boolean {
    return err?.errorMessage === 'CHANNEL_INVALID'
      || err?.errorMessage === 'CHANNEL_PRIVATE'
      || /could not find the input entity/i.test(String(err?.message ?? ''));
  }

  /** Load recent dialogs to populate the session's entity cache (access
   *  hashes). Throttled to once per 60s unless forced. Best-effort —
   *  failures are swallowed so a poll never dies on a warm. */
  private async warmDialogs(force = false): Promise<void> {
    if (!this.client) return;
    const now = Date.now();
    if (!force && now - this.dialogsWarmedAt < 60_000) return;
    this.dialogsWarmedAt = now;
    try {
      const dialogs = await this.client.getDialogs({ limit: 500 });
      this.logger.debug(`warmDialogs: cached ${dialogs.length} dialogs`);
    } catch (err: any) {
      this.logger.debug(`warmDialogs failed: ${err?.errorMessage ?? err?.message ?? err}`);
    }
  }

  /**
   * Resolve an address to a gramjs entity, re-warming the dialog cache and
   * retrying once on a cache miss. This handles the common case where the
   * account subscribed to the channel AFTER the client connected: the entity
   * isn't cached yet, so the first getEntity throws "could not find the input
   * entity". We re-warm dialogs (which now include the freshly-joined
   * channel) and retry before concluding the session truly can't see it.
   *
   * Returns the entity, or 'not_subscribed' when it's unreachable even after
   * a re-warm. Re-throws non-miss errors (flood waits etc.) for the caller's
   * handleApiError.
   */
  private async resolveEntity(address: string | number): Promise<any | 'not_subscribed'> {
    try {
      return await this.client!.getEntity(address as any);
    } catch (err: any) {
      if (!this.isEntityMiss(err)) throw err;
      await this.warmDialogs();
      try {
        return await this.client!.getEntity(address as any);
      } catch (err2: any) {
        if (this.isEntityMiss(err2)) return 'not_subscribed';
        throw err2;
      }
    }
  }

  async getFullChannel(usernameOrId: string): Promise<FullChannelResult | 'not_subscribed' | null> {
    if (!this.ready || !this.client) return null;
    const address = this.toAddress(usernameOrId);
    if (address === null) return null;
    try {
      const entity = await this.resolveEntity(address);
      if (entity === 'not_subscribed') {
        this.logger.debug(`getFullChannel: ${usernameOrId} not reachable by session (not subscribed)`);
        return 'not_subscribed';
      }
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
      // GetFullChannel itself rejects with CHANNEL_INVALID when the session
      // resolved a stale cached entity it's no longer a member of.
      if (this.isEntityMiss(err)) {
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
      const entity = await this.resolveEntity(address);
      if (entity === 'not_subscribed') {
        this.logger.debug(`getHistory: ${usernameOrId} not reachable by session (not subscribed)`);
        return [];
      }
      const res    = await this.client.invoke(
        new Api.messages.GetHistory({ peer: entity as any, limit, minId: offsetId, offsetId: 0 }),
      );
      const msgs   = (res as any).messages as any[];
      return msgs
        .filter((m) => m.className === 'Message')
        .map((m) => this.toRawMessage(m));
    } catch (err: any) {
      if (this.isEntityMiss(err)) {
        this.logger.debug(`getHistory: ${usernameOrId} not reachable by session (not subscribed)`);
        return [];
      }
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
