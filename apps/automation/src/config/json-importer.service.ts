// apps/automation/src/config/json-importer.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { MyBotsRepository } from './my-bots.repository';
import { TrackedChannelsConfigRepository } from './tracked-channels.repository';
import { StrategyBindingsRepository } from './strategy-bindings.repository';
import { ForwardRoutesRepository } from './forward-routes.repository';

interface RawJsonConfig {
  bots?: Record<string, { platform?: string; tokenEnv: string }>;
  channels?: Record<string, {
    platform?: string;
    chatId?:   string;
    botId?:    string;
    forwardRoutes?: Array<{ topic: string; channelId: string; description: string }>;
  }>;
  strategies?: Array<{
    id:        string;
    type:      string;
    channelId: string;
    schedule:  string;
    params?:   Record<string, unknown>;
  }>;
}

@Injectable()
export class JsonImporterService {
  private readonly logger = new Logger(JsonImporterService.name);
  private readonly configDir = join(__dirname, '..', '..', 'config');

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly bots:     MyBotsRepository,
    private readonly channels: TrackedChannelsConfigRepository,
    private readonly bindings: StrategyBindingsRepository,
    private readonly forwards: ForwardRoutesRepository,
  ) {}

  /** Idempotent. Reads channels.<env>.json once per env, writes once to DB. */
  async importIfNeeded(env: 'local-development' | 'dev-stage' | 'production'): Promise<{
    skipped: boolean; bots: number; channels: number; strategies: number; forwards: number;
  }> {
    const sentinel = `config_imported_${env}`;
    if (await this.hasMigration(sentinel)) {
      this.logger.debug(`Import skipped — sentinel ${sentinel} present`);
      return { skipped: true, bots: 0, channels: 0, strategies: 0, forwards: 0 };
    }

    const file = this.resolveFile(env);
    if (!file || !existsSync(file)) {
      this.logger.warn(`No JSON file found for env=${env}, skipping import`);
      await this.markMigration(sentinel);
      return { skipped: true, bots: 0, channels: 0, strategies: 0, forwards: 0 };
    }

    const raw = JSON.parse(readFileSync(file, 'utf-8')) as RawJsonConfig;

    let botsCount = 0, chCount = 0, sCount = 0, fwCount = 0;

    // 1. Bots
    for (const [botId, b] of Object.entries(raw.bots ?? {})) {
      const existing = await this.bots.findByBotId(botId);
      if (!existing) {
        await this.bots.insert({ bot_id: botId, token_env: b.tokenEnv, platform: b.platform ?? 'telegram' });
        botsCount++;
      }
    }

    // 2. Channels (need bot ids resolved)
    const channelKeyToId = new Map<string, string>();
    for (const [channelKey, ch] of Object.entries(raw.channels ?? {})) {
      const botRow = ch.botId ? await this.bots.findByBotId(ch.botId) : null;
      const isPrivate = (ch.chatId ?? channelKey).startsWith('-');
      const id = await this.channels.upsertByKey({
        channel_key: channelKey,
        username:    isPrivate ? null : channelKey.replace(/^@/, ''),
        tg_chat_id:  isPrivate ? (ch.chatId ?? channelKey) : null,
        kind:        isPrivate ? 'private' : 'public',
        bot_id:      botRow?.id ?? null,
        is_mine:     true,
      });
      channelKeyToId.set(channelKey, id);
      chCount++;
    }

    // 3. Forward routes (need both source + target resolved as channel ids)
    for (const [channelKey, ch] of Object.entries(raw.channels ?? {})) {
      const sourceId = channelKeyToId.get(channelKey);
      if (!sourceId) continue;
      for (const route of ch.forwardRoutes ?? []) {
        const targetId = channelKeyToId.get(route.channelId);
        if (!targetId) {
          this.logger.warn(`Forward route ${channelKey}→${route.channelId} skipped — target not in channels map`);
          continue;
        }
        const inserted = await this.forwards.insertIfMissing({
          source_channel_id: sourceId,
          target_channel_id: targetId,
          topic:             route.topic,
          description:       route.description,
        });
        if (inserted) fwCount++;
      }
    }

    // 4. Strategies
    for (const s of raw.strategies ?? []) {
      const channelId = channelKeyToId.get(s.channelId);
      if (!channelId) {
        this.logger.warn(`Strategy ${s.id} skipped — channel ${s.channelId} not in channels map`);
        continue;
      }
      const inserted = await this.bindings.insertIfMissing({
        ext_id:     s.id,
        type:       s.type,
        channel_id: channelId,
        schedule:   s.schedule,
        params:     s.params ?? {},
        enabled:    true,
      });
      if (inserted) sCount++;
    }

    await this.markMigration(sentinel);
    this.logger.log(
      `Imported channels.${env}.json → bots=${botsCount} channels=${chCount} strategies=${sCount} forwards=${fwCount}`,
    );

    return { skipped: false, bots: botsCount, channels: chCount, strategies: sCount, forwards: fwCount };
  }

  private resolveFile(env: string): string | null {
    if (env === 'local-development') {
      const local = join(this.configDir, 'channels.local.json');
      if (existsSync(local)) return local;
      return join(this.configDir, 'channels-dev.json');
    }
    if (env === 'dev-stage') return join(this.configDir, 'channels-dev.json');
    return join(this.configDir, 'channels.json');
  }

  private async hasMigration(version: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM schema_migrations WHERE version = $1`, [version],
    );
    return rows.length > 0;
  }

  private async markMigration(version: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING`,
      [version],
    );
  }
}
