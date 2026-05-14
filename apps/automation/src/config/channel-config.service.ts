import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { StrategyConfigEntry, StrategyParams } from '../common/content-strategy/content-strategy.interface';

// ─── Config file types ────────────────────────────────────────────────────────

export interface BotConfig {
  platform: string;
  /** Name of the env variable that holds the bot token */
  tokenEnv: string;
}

export interface ForwardRoute {
  /** Topic key the router returns to pick this route (lowercase, single word) */
  topic:       string;
  /** Target channel id from the `channels` map */
  channelId:   string;
  /** Human description of what content matches — fed to the router agent */
  description: string;
}

export interface ChannelConfig {
  platform: string;
  chatId: string;
  /** Single bot id or array for round-robin rotation */
  botId: string | string[];
  /**
   * Semantic-dedup window in hours. Checks recent posts on this channel (across
   * all strategies) for topical overlap before publishing. Omit to use default
   * (8 hours). Set to 0 to disable semantic dedup entirely for this channel.
   */
  semanticDedupHours?: number;
  /**
   * After a successful publish, a router agent can forward the message to one
   * matching topic-specific channel. Omit or leave empty to disable routing.
   */
  forwardRoutes?: ForwardRoute[];
}

interface ChannelsFile {
  bots:        Record<string, BotConfig>;
  channels:    Record<string, ChannelConfig>;
  strategies?: StrategyConfigEntry[];
}

// ─── Resolved types ─────────────────────────────────────────────────────────

export interface ResolvedChannel {
  platform:  string;
  chatId:    string;
  botToken:  string;
  botId:     string;
}

export interface ResolvedStrategyBinding {
  id:          string;
  type:        string;
  channelId:   string;
  schedule:    string;
  postDelayMs: number;
  params:      StrategyParams;
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class ChannelConfigService implements OnModuleInit {
  private readonly logger = new Logger(ChannelConfigService.name);
  private cfg: ChannelsFile;
  private readonly rotationIdx = new Map<string, number>();

  constructor(private readonly env: ConfigService) {}

  private static readonly DEFAULT_SCHEDULE       = '0 8-23/2 * * *';
  private static readonly DEFAULT_DELAY_MINUTES  = 30;
  private static readonly DEFAULT_SEMANTIC_DEDUP_HOURS = 8;

  onModuleInit() {
    // Strict resolution — refuses to silently fall back to dev config when
    // NODE_ENV is missing. Prevents a production deploy from accidentally
    // loading channels-dev.json with its */5 cadence (real-world bug we
    // chased for hours).
    const nodeEnv = process.env.NODE_ENV;
    if (!nodeEnv) {
      this.logger.warn(
        'NODE_ENV is not set — defaulting to development config. ' +
        'Set NODE_ENV=production explicitly in docker-compose.yml or .env.',
      );
    }
    const isDev    = (nodeEnv ?? 'development') === 'development';
    const fileName = isDev ? 'channels-dev.json' : 'channels.json';
    const path     = join(__dirname, '..', '..', 'config', fileName);
    this.cfg = JSON.parse(readFileSync(path, 'utf-8'));

    // Loud, unambiguous boot line — useful when triaging "wrong config" issues.
    this.logger.log(
      `Config: ${fileName} (NODE_ENV=${nodeEnv ?? 'unset'}) | ` +
      `${Object.keys(this.cfg.bots).length} bot(s), ` +
      `${Object.keys(this.cfg.channels).length} channel(s), ` +
      `${(this.cfg.strategies ?? []).length} strategy(ies)`,
    );
  }

  // ── Channel resolution ───────────────────────────────────────────────────

  resolveChannel(channelId: string): ResolvedChannel {
    const ch = this.cfg.channels[channelId];
    if (!ch) throw new Error(`Channel "${channelId}" not found in channels.json`);

    const botId = this.pickBot(channelId, ch.botId);
    const bot   = this.cfg.bots[botId];
    if (!bot) throw new Error(`Bot "${botId}" not found in channels.json`);

    const token = this.env.get<string>(bot.tokenEnv);
    if (!token) throw new Error(`Env var "${bot.tokenEnv}" is not set (bot: ${botId})`);

    return { platform: ch.platform, chatId: ch.chatId, botToken: token, botId };
  }

  // ── Strategy resolution ──────────────────────────────────────────────────

  resolveStrategyBindings(): ResolvedStrategyBinding[] {
    return (this.cfg.strategies ?? []).map((s) => ({
      id:          s.id,
      type:        s.type,
      channelId:   s.channelId,
      schedule:    s.schedule    ?? ChannelConfigService.DEFAULT_SCHEDULE,
      postDelayMs: (s.postDelayMinutes ?? ChannelConfigService.DEFAULT_DELAY_MINUTES) * 60_000,
      params:      s.params ?? {},
    }));
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  listChannels(): string[] { return Object.keys(this.cfg.channels); }

  /**
   * Returns the semantic-dedup window for a channel in hours.
   * Default: 8 hours. Returns 0 if the channel opts out.
   */
  getSemanticDedupHours(channelId: string): number {
    const ch = this.cfg.channels[channelId];
    if (!ch) return ChannelConfigService.DEFAULT_SEMANTIC_DEDUP_HOURS;
    return ch.semanticDedupHours ?? ChannelConfigService.DEFAULT_SEMANTIC_DEDUP_HOURS;
  }

  /** Forward routes declared on a source channel. Empty array if none. */
  getForwardRoutes(channelId: string): ForwardRoute[] {
    const ch = this.cfg.channels[channelId];
    return ch?.forwardRoutes ?? [];
  }

  private pickBot(channelId: string, botId: string | string[]): string {
    if (typeof botId === 'string') return botId;
    const idx = this.rotationIdx.get(channelId) ?? 0;
    this.rotationIdx.set(channelId, (idx + 1) % botId.length);
    return botId[idx];
  }
}
