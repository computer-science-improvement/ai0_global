// apps/automation/src/config/json-importer.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { Pool, PoolClient } from 'pg';
import { DB_POOL } from '../database/database.module';

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

/**
 * One-shot importer: reads `channels.<env>.json` and writes bots / channels /
 * strategies / forward routes into Postgres. Guarded by a `config_imported_<env>`
 * sentinel in `schema_migrations` — runs exactly once per env, ever.
 *
 * Implementation note: the whole import runs inside a single transaction on a
 * dedicated `PoolClient`. The sentinel row is the last statement before COMMIT,
 * so a crash mid-import leaves no partial state and no sentinel — the next boot
 * retries from scratch. Inline SQL (rather than the per-table repos) keeps the
 * transaction on one connection without threading an executor argument through
 * every repo method.
 */
@Injectable()
export class JsonImporterService {
  private readonly logger = new Logger(JsonImporterService.name);
  private readonly configDir = join(__dirname, '..', '..', 'config');

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

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
      // Mark sentinel so we don't keep re-checking. Idempotent.
      await this.pool.query(
        `INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING`,
        [sentinel],
      );
      return { skipped: true, bots: 0, channels: 0, strategies: 0, forwards: 0 };
    }

    const raw = JSON.parse(readFileSync(file, 'utf-8')) as RawJsonConfig;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const counts = await this.importTx(client, raw, sentinel);
      await client.query('COMMIT');
      this.logger.log(
        `Imported channels.${env}.json → ` +
        `bots=${counts.bots} channels=${counts.channels} ` +
        `strategies=${counts.strategies} forwards=${counts.forwards}`,
      );
      return { skipped: false, ...counts };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
      throw err;
    } finally {
      client.release();
    }
  }

  private async importTx(
    client: PoolClient,
    raw: RawJsonConfig,
    sentinel: string,
  ): Promise<{ bots: number; channels: number; strategies: number; forwards: number }> {
    let botsCount = 0, chCount = 0, sCount = 0, fwCount = 0;

    // 1. Bots — pre-load all once, no N+1.
    const { rows: existingBots } = await client.query<{ id: string; bot_id: string }>(
      `SELECT id, bot_id FROM my_bots`,
    );
    const botExtToUuid = new Map(existingBots.map(b => [b.bot_id, b.id]));

    for (const [botId, b] of Object.entries(raw.bots ?? {})) {
      if (botExtToUuid.has(botId)) continue;
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO my_bots (bot_id, token_env, platform)
         VALUES ($1, $2, COALESCE($3, 'telegram'))
         RETURNING id`,
        [botId, b.tokenEnv, b.platform ?? null],
      );
      botExtToUuid.set(botId, rows[0].id);
      botsCount++;
    }

    // 2. Channels — `kind` derives from channelKey ('@' → public, '-' → private).
    //    A channel may have a numeric `-100…` chatId AND an `@username` channelKey;
    //    that's still a public channel, so we must NOT branch on chatId.
    const channelKeyToId = new Map<string, string>();
    for (const [channelKey, ch] of Object.entries(raw.channels ?? {})) {
      const isPrivate = channelKey.startsWith('-');
      const botUuid   = ch.botId ? botExtToUuid.get(ch.botId) ?? null : null;

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO tracked_channels
           (channel_key, username, tg_chat_id, kind, bot_id, is_mine, poll_tier)
         VALUES ($1, $2, $3, $4, $5, true, 'warm')
         ON CONFLICT (channel_key) WHERE channel_key IS NOT NULL DO UPDATE SET
           username   = EXCLUDED.username,
           tg_chat_id = EXCLUDED.tg_chat_id,
           kind       = EXCLUDED.kind,
           bot_id     = EXCLUDED.bot_id,
           is_mine    = EXCLUDED.is_mine
         RETURNING id`,
        [
          channelKey,
          isPrivate ? null : channelKey.replace(/^@/, ''),
          isPrivate ? (ch.chatId ?? channelKey) : null,
          isPrivate ? 'private' : 'public',
          botUuid,
        ],
      );
      channelKeyToId.set(channelKey, rows[0].id);
      chCount++;
    }

    // 3. Forward routes — both ends must resolve to channel ids we just upserted.
    for (const [channelKey, ch] of Object.entries(raw.channels ?? {})) {
      const sourceId = channelKeyToId.get(channelKey);
      if (!sourceId) continue;
      for (const route of ch.forwardRoutes ?? []) {
        const targetId = channelKeyToId.get(route.channelId);
        if (!targetId) {
          this.logger.warn(`Forward route ${channelKey}→${route.channelId} skipped — target not in channels map`);
          continue;
        }
        const { rowCount } = await client.query(
          `INSERT INTO forward_routes (source_channel_id, target_channel_id, topic, description)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (source_channel_id, topic) DO NOTHING`,
          [sourceId, targetId, route.topic, route.description],
        );
        if ((rowCount ?? 0) > 0) fwCount++;
      }
    }

    // 4. Strategies.
    for (const s of raw.strategies ?? []) {
      const channelId = channelKeyToId.get(s.channelId);
      if (!channelId) {
        this.logger.warn(`Strategy ${s.id} skipped — channel ${s.channelId} not in channels map`);
        continue;
      }
      const { rowCount } = await client.query(
        `INSERT INTO strategy_bindings (ext_id, type, channel_id, schedule, params, enabled)
         VALUES ($1, $2, $3, $4, $5::jsonb, true)
         ON CONFLICT (ext_id) DO NOTHING`,
        [s.id, s.type, channelId, s.schedule, JSON.stringify(s.params ?? {})],
      );
      if ((rowCount ?? 0) > 0) sCount++;
    }

    // 5. Sentinel — last statement before COMMIT, so a rollback also rolls this back.
    await client.query(
      `INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING`,
      [sentinel],
    );

    return { bots: botsCount, channels: chCount, strategies: sCount, forwards: fwCount };
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
}
