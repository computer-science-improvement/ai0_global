import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { StrategyConfigEntry, StrategyParams } from '../common/content-strategy/content-strategy.interface';

/**
 * Explicit three-state environment. `NODE_ENV` must be exactly one of these
 * values — anything else (including the implicit empty default) fails boot.
 * This prevents the historical bug where a missing NODE_ENV silently loaded
 * dev config in prod (or vice versa).
 */
const VALID_ENVS = ['local-development', 'dev-stage', 'production'] as const;
type AppEnv = (typeof VALID_ENVS)[number];

function isAppEnv(v: string | undefined): v is AppEnv {
  return !!v && (VALID_ENVS as readonly string[]).includes(v);
}

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
    // Strict three-state resolution — anything other than the validated set
    // fails the boot loudly. Prevents two historical incidents:
    //   1. NODE_ENV=development (implicit) silently loading dev config in prod.
    //   2. Six rogue `pnpm dev:automation` watch processes on the user's
    //      laptop sharing the prod .env, each posting into prod channels.
    // Now: prod is `production`, dev-stage server is `dev-stage`, the user's
    // laptop is `local-development` and may opt into `channels.local.json`.
    const nodeEnv = process.env.NODE_ENV;
    if (!isAppEnv(nodeEnv)) {
      const got = nodeEnv === undefined ? 'unset' : `"${nodeEnv}"`;
      throw new Error(
        `NODE_ENV is ${got}. Must be one of: ${VALID_ENVS.join(', ')}. ` +
        `Set it in .env (laptop: local-development, dev-stage server: dev-stage, ` +
        `prod server: production).`,
      );
    }

    const configDir = join(__dirname, '..', '..', 'config');
    const fileName = this.resolveConfigFile(nodeEnv, configDir);
    const path = join(configDir, fileName);

    if (!existsSync(path)) {
      throw new Error(
        `Config file not found: ${path} (NODE_ENV=${nodeEnv}). ` +
        `Each environment must have its own channels file present.`,
      );
    }

    this.cfg = JSON.parse(readFileSync(path, 'utf-8'));

    // Loud, unambiguous boot line — useful when triaging "wrong config" issues.
    this.logger.log(
      `Config: ${fileName} (NODE_ENV=${nodeEnv}) | ` +
      `${Object.keys(this.cfg.bots).length} bot(s), ` +
      `${Object.keys(this.cfg.channels).length} channel(s), ` +
      `${(this.cfg.strategies ?? []).length} strategy(ies)`,
    );
  }

  /**
   * Decide which `channels*.json` file to load based on NODE_ENV.
   * - `local-development`: prefer `channels.local.json` (gitignored, user-owned),
   *   fall back to `channels-dev.json` if the local file isn't present.
   * - `dev-stage`: `channels-dev.json` only. No fallback.
   * - `production`: `channels.json` only. No fallback.
   */
  private resolveConfigFile(env: AppEnv, configDir: string): string {
    if (env === 'local-development') {
      const local = 'channels.local.json';
      if (existsSync(join(configDir, local))) return local;
      this.logger.log(
        `${local} not found in config dir — falling back to channels-dev.json`,
      );
      return 'channels-dev.json';
    }
    if (env === 'dev-stage') return 'channels-dev.json';
    return 'channels.json';
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
