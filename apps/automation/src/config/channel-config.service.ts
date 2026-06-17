// apps/automation/src/config/channel-config.service.ts
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigCacheService } from './config-cache.service';
import { JsonImporterService } from './json-importer.service';
import { SecretsService } from '../common/crypto/secrets.service';
import type { DestinationPlatform } from '../common/content-strategy/publish-destination';

export type AppEnv = 'local-development' | 'dev-stage' | 'production';
const VALID_ENVS: AppEnv[] = ['local-development', 'dev-stage', 'production'];
const isAppEnv = (v: unknown): v is AppEnv =>
  typeof v === 'string' && (VALID_ENVS as string[]).includes(v);

export interface ResolvedChannel {
  platform:  string;
  chatId:    string;
  botToken:  string;
  botId:     string;
}

export interface ResolvedStrategyBinding {
  id:         string;
  /** Internal UUID — used by run-logging to FK back into strategy_bindings. */
  uuid:       string;
  type:       string;
  /** TG channel_key (resolved) for telegram bindings; '' for meta bindings. */
  channelId:  string;
  schedule:   string;
  params:     Record<string, unknown>;
  enabled:    boolean;
  /** Destination kind. 'telegram' = publish to channelId; otherwise a Meta platform. */
  platform:   DestinationPlatform;
  /** Meta account UUID when platform != 'telegram'; null otherwise. */
  metaAccountId: string | null;
  /** TikTok account UUID when platform == 'tiktok'; null otherwise. */
  tiktokAccountId: string | null;
}

export interface ForwardRoute {
  topic:       string;
  channelId:   string;
  description: string;
}

@Injectable()
export class ChannelConfigService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ChannelConfigService.name);

  private static readonly DEFAULT_SEMANTIC_DEDUP_HOURS = 8;

  constructor(
    private readonly env:      ConfigService,
    private readonly cache:    ConfigCacheService,
    private readonly importer: JsonImporterService,
    private readonly secrets:  SecretsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const nodeEnv = process.env.NODE_ENV;
    if (!isAppEnv(nodeEnv)) {
      const got = nodeEnv === undefined ? 'unset' : `"${nodeEnv}"`;
      throw new Error(
        `NODE_ENV is ${got}. Must be one of: ${VALID_ENVS.join(', ')}. ` +
        `Set it in .env (laptop: local-development, dev-stage server: dev-stage, prod server: production).`,
      );
    }

    const stats = await this.importer.importIfNeeded(nodeEnv);
    // Always reload — NestJS doesn't guarantee that ConfigCacheService's
    // onApplicationBootstrap (which also does an initial hydrate) ran first.
    // Without this explicit reload, we may log stale counts and downstream
    // boot consumers (Scheduler etc.) might race with empty caches.
    void stats;
    await this.cache.reload();

    const bots = this.cache.getAllBots();
    const channels = this.cache.getAllChannels();
    const bindings = this.cache.getBindings();
    this.logger.log(
      `Config: source=DB (NODE_ENV=${nodeEnv}) | ${bots.length} bot(s), ${channels.length} channel(s), ${bindings.length} strategy(ies)`,
    );
  }

  resolveChannel(channelKey: string): ResolvedChannel {
    const ch = this.cache.getChannelByKey(channelKey)
            ?? this.cache.getChannelById(channelKey);
    if (!ch) throw new Error(`Channel "${channelKey}" not found in config`);

    const bot = ch.bot_id ? this.cache.getBotById(ch.bot_id) : null;
    if (!bot) throw new Error(`Channel "${channelKey}" has no bot bound`);

    const token = this.secrets.resolveToken(
      { enc: bot.token_enc, env: bot.token_env }, (k) => this.env.get<string>(k),
    );
    if (!token) {
      throw new Error(`Env var "${bot.token_env}" is not set (bot: ${bot.bot_id})`);
    }

    const chatId = ch.kind === 'private'
      ? (ch.tg_chat_id ?? channelKey)
      : (ch.channel_key ?? channelKey);

    return {
      platform: 'telegram',
      chatId,
      botToken: token,
      botId:    bot.bot_id,
    };
  }

  /** Resolve a channel key/id → its UUID + public username (for cross-posting). */
  getChannelMeta(channelKeyOrId: string): { id: string; username: string | null } | null {
    const ch = this.cache.getChannelByKey(channelKeyOrId)
            ?? this.cache.getChannelById(channelKeyOrId);
    return ch ? { id: ch.id, username: ch.username } : null;
  }

  resolveStrategyBindings(): ResolvedStrategyBinding[] {
    return this.cache.getBindings().map(b => {
      const ch = b.channel_id ? this.cache.getChannelById(b.channel_id) : null;
      return {
        id:        b.ext_id,
        uuid:      b.id,
        type:      b.type,
        channelId: ch?.channel_key ?? b.channel_id ?? '',
        schedule:  b.schedule,
        params:    b.params,
        enabled:   b.enabled,
        platform:  b.platform,
        metaAccountId: b.meta_account_id,
        tiktokAccountId: b.tiktok_account_id,
      };
    });
  }

  getForwardRoutes(channelKey: string): ForwardRoute[] {
    const ch = this.cache.getChannelByKey(channelKey);
    if (!ch) return [];
    const routes = this.cache.getForwardRoutesForSource(ch.id);
    return routes.map(r => {
      const target = this.cache.getChannelById(r.target_channel_id);
      return {
        topic:       r.topic,
        channelId:   target?.channel_key ?? r.target_channel_id,
        description: r.description,
      };
    });
  }

  listChannels(): string[] {
    return this.cache.getAllChannels()
      .map(c => c.channel_key)
      .filter((k): k is string => !!k);
  }

  /**
   * Per-channel publishing kill switch (tracked_channels.publish_paused).
   * Independent of strategy_bindings.enabled — pausing a channel stops
   * every strategy and every forward into it without touching the
   * binding's enabled state. Returns true when the channel exists and
   * is paused; false in every other case (channel missing → no
   * restriction signalled, the publisher will fail naturally elsewhere).
   */
  isPublishPausedFor(channelKey: string): boolean {
    const ch = this.cache.getChannelByKey(channelKey)
            ?? this.cache.getChannelById(channelKey);
    return !!ch?.publish_paused;
  }

  /**
   * Returns the semantic-dedup window in hours. Currently a global env-driven
   * value (SEMANTIC_DEDUP_HOURS, default 8). The optional `channelKey` arg is
   * accepted for backward compatibility with callers but ignored — per-channel
   * overrides are no longer in the config schema.
   */
  getSemanticDedupHours(_channelKey?: string): number {
    const v = this.env.get<string>('SEMANTIC_DEDUP_HOURS');
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : ChannelConfigService.DEFAULT_SEMANTIC_DEDUP_HOURS;
  }
}
