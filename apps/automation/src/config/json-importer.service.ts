import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DB_POOL } from '../database/database.tokens';
import { MyBotsRepository } from './my-bots.repository';
import { TrackedChannelsConfigRepository } from './tracked-channels.repository';
import { StrategyBindingsRepository } from './strategy-bindings.repository';
import { ForwardRoutesRepository } from './forward-routes.repository';

type AppEnv = 'local-development' | 'dev-stage' | 'production';

interface BotJson {
  platform: string;
  tokenEnv: string;
}

interface ForwardRouteJson {
  topic:       string;
  channelId:   string;
  description: string;
}

interface ChannelJson {
  platform:           string;
  chatId:             string;
  botId:              string | string[];
  semanticDedupHours?: number;
  forwardRoutes?:     ForwardRouteJson[];
}

interface StrategyJson {
  id:                string;
  type:              string;
  channelId:         string;
  schedule?:         string;
  postDelayMinutes?: number;
  params?:           Record<string, unknown>;
}

interface ChannelsFile {
  bots:        Record<string, BotJson>;
  channels:    Record<string, ChannelJson>;
  strategies?: StrategyJson[];
}

@Injectable()
export class JsonImporterService {
  private readonly logger = new Logger(JsonImporterService.name);

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly bots:     MyBotsRepository,
    private readonly channels: TrackedChannelsConfigRepository,
    private readonly bindings: StrategyBindingsRepository,
    private readonly routes:   ForwardRoutesRepository,
  ) {}

  async importIfNeeded(env: AppEnv): Promise<void> {
    const sentinel = `config_imported_${env}`;

    const sentinelRow = await this.pool.query<{ version: string }>(
      `SELECT version FROM schema_migrations WHERE version = $1`,
      [sentinel],
    );
    if (sentinelRow.rowCount && sentinelRow.rowCount > 0) {
      this.logger.log(`Config already imported for env=${env} — skipping`);
      return;
    }

    const path = this.resolveConfigPath(env);
    if (!path) {
      this.logger.warn(`No config file resolved for env=${env} — skipping import`);
      return;
    }

    let cfg: ChannelsFile;
    try {
      cfg = JSON.parse(readFileSync(path, 'utf-8')) as ChannelsFile;
    } catch (e: any) {
      throw new Error(`Failed to read/parse config file ${path}: ${e?.message ?? String(e)}`);
    }

    this.logger.log(
      `Importing config from ${path}: ` +
      `${Object.keys(cfg.bots ?? {}).length} bot(s), ` +
      `${Object.keys(cfg.channels ?? {}).length} channel(s), ` +
      `${(cfg.strategies ?? []).length} strategy(ies)`,
    );

    // 1. Bots
    const botIdMap = new Map<string, string>();   // bot-key (e.g. "ai0_local_test_bot") → uuid
    for (const [botKey, bot] of Object.entries(cfg.bots ?? {})) {
      const existing = await this.bots.findByBotId(botKey);
      if (existing) {
        botIdMap.set(botKey, existing.id);
        continue;
      }
      const id = await this.bots.insert({
        botId:    botKey,
        platform: bot.platform ?? 'telegram',
        tokenEnv: bot.tokenEnv,
        active:   true,
      });
      botIdMap.set(botKey, id);
    }

    // 2. Channels — must come before forward_routes / strategies (they reference channels)
    const channelIdMap = new Map<string, string>();   // channel-key (e.g. "@pdr_local") → uuid
    for (const [channelKey, ch] of Object.entries(cfg.channels ?? {})) {
      const firstBot = Array.isArray(ch.botId) ? ch.botId[0] : ch.botId;
      const botUuid  = firstBot ? botIdMap.get(firstBot) ?? null : null;
      const kind     = this.computeKind(channelKey);

      const id = await this.channels.upsertByKey({
        channelKey,
        kind,
        botId:    botUuid,
        tgChatId: typeof ch.chatId === 'string' && /^-?\d+$/.test(ch.chatId) ? ch.chatId : null,
        username: channelKey.startsWith('@') ? channelKey.slice(1) : null,
        isMine:   true,
      });
      channelIdMap.set(channelKey, id);
    }

    // 3. Forward routes — channels exist now
    for (const [channelKey, ch] of Object.entries(cfg.channels ?? {})) {
      const sourceId = channelIdMap.get(channelKey);
      if (!sourceId) continue;
      for (const route of ch.forwardRoutes ?? []) {
        const targetId = channelIdMap.get(route.channelId);
        if (!targetId) {
          this.logger.warn(
            `Forward route target "${route.channelId}" from "${channelKey}" not found — skipping`,
          );
          continue;
        }
        await this.routes.insertIfMissing({
          sourceChannelId: sourceId,
          targetChannelId: targetId,
          topic:           route.topic,
          description:     route.description,
        });
      }
    }

    // 4. Strategies
    for (const s of cfg.strategies ?? []) {
      const channelUuid = channelIdMap.get(s.channelId);
      if (!channelUuid) {
        this.logger.warn(
          `Strategy "${s.id}" references unknown channel "${s.channelId}" — skipping`,
        );
        continue;
      }
      const params: Record<string, unknown> = { ...(s.params ?? {}) };
      if (s.postDelayMinutes !== undefined) params.postDelayMinutes = s.postDelayMinutes;
      await this.bindings.insertIfMissing({
        extId:     s.id,
        type:      s.type,
        channelId: channelUuid,
        schedule:  s.schedule ?? '0 8-23/2 * * *',
        params,
        enabled:   true,
      });
    }

    await this.pool.query(
      `INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
      [sentinel],
    );
    this.logger.log(`Config import complete for env=${env}`);
  }

  private resolveConfigPath(env: AppEnv): string | null {
    const configDir = join(__dirname, '..', '..', 'config');
    if (env === 'local-development') {
      const local = join(configDir, 'channels.local.json');
      if (existsSync(local)) return local;
      const dev = join(configDir, 'channels-dev.json');
      if (existsSync(dev)) return dev;
      return null;
    }
    if (env === 'dev-stage') {
      const p = join(configDir, 'channels-dev.json');
      return existsSync(p) ? p : null;
    }
    const p = join(configDir, 'channels.json');
    return existsSync(p) ? p : null;
  }

  private computeKind(channelKey: string): string {
    // Channel keys in channels.<env>.json are typically `@username` for Telegram.
    if (channelKey.startsWith('@')) return 'telegram';
    return 'unknown';
  }
}
