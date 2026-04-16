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

export interface ChannelConfig {
  platform: string;
  chatId: string;
  /** Single bot id or array for round-robin rotation */
  botId: string | string[];
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

  onModuleInit() {
    const isDev     = (process.env.NODE_ENV ?? 'development') === 'development';
    const fileName  = isDev ? 'channels-dev.json' : 'channels.json';
    const path      = join(__dirname, '..', '..', 'config', fileName);
    this.cfg = JSON.parse(readFileSync(path, 'utf-8'));

    this.logger.log(
      `Config: ${fileName} | ` +
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

  private pickBot(channelId: string, botId: string | string[]): string {
    if (typeof botId === 'string') return botId;
    const idx = this.rotationIdx.get(channelId) ?? 0;
    this.rotationIdx.set(channelId, (idx + 1) % botId.length);
    return botId[idx];
  }
}
