import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { OwnerInbox } from '../editor/agents/owner-inbox';
import { TelegramNotifier } from '../publishers/telegram-notifier.service';
import { SecretsService } from '../common/crypto/secrets.service';
import { kyivDay } from '../common/ai/usage/kyiv-day';
import { MetaAccountsRepository } from './meta-accounts.repository';
import { MetaGraphClient } from './meta-graph.client';
import { MyBotsRepository } from './my-bots.repository';
import { TelegramGetMeClient } from './telegram-getme.client';
import { TelegraphAccountsRepository } from './telegraph-accounts.repository';
import { TelegraphGetInfoClient } from './telegraph-getinfo.client';
import { TikTokAccountsRepository } from './tiktok-accounts.repository';
import { TikTokTokenService } from './tiktok-token.service';
import { MtprotoSessionsRepository } from './mtproto-sessions.repository';
import { ConfigEventsPublisher } from './config-events.publisher';
import { runConnectionKeeper } from './connection-keeper';

/**
 * Spec 049 FR-001: the daily connection upkeep (see `runConnectionKeeper`). It runs at 05:40, before the resource
 * health check of 06:10 (same server time zone), so the health check reads fresh token state.
 * CONNECTION_KEEPER=off disables it.
 */
@Injectable()
export class ConnectionKeeperUpkeep {
  private readonly logger = new Logger('ConnectionKeeper');
  private running = false;

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly config: ConfigService,
    private readonly secrets: SecretsService,
    private readonly meta: MetaAccountsRepository,
    private readonly graph: MetaGraphClient,
    private readonly bots: MyBotsRepository,
    private readonly getMe: TelegramGetMeClient,
    private readonly telegraph: TelegraphAccountsRepository,
    private readonly telegraphInfo: TelegraphGetInfoClient,
    private readonly tiktokAccounts: TikTokAccountsRepository,
    private readonly tiktokTokens: TikTokTokenService,
    private readonly mtproto: MtprotoSessionsRepository,
    private readonly events: ConfigEventsPublisher,
    @Optional() private readonly notifier?: TelegramNotifier,
  ) {}

  private enabled(): boolean { return this.config.get<string>('CONNECTION_KEEPER') !== 'off'; }

  @Cron('40 5 * * *', { name: 'connection-keeper' })
  async tick(): Promise<void> {
    if (this.running || !this.enabled()) return;
    this.running = true;
    try {
      const inbox = new OwnerInbox(this.pool, this.notifier ? (t) => this.notifier!.notifyAlert(t) : async () => {}, this.config.get<string>('DASHBOARD_URL') ?? null);
      const r = await runConnectionKeeper({
        meta: this.meta, graph: this.graph, bots: this.bots, getMe: (t) => this.getMe.getMe(t),
        telegraph: this.telegraph, telegraphInfo: (t) => this.telegraphInfo.getAccountInfo(t),
        tiktok: { list: () => this.tiktokAccounts.list(), getValidAccessToken: (id) => this.tiktokTokens.getValidAccessToken(id) },
        mtproto: this.mtproto,
        token: (row) => this.secrets.resolveToken({ enc: row.token_enc, env: row.token_env }, (k) => this.config.get<string>(k)) || null,
        encrypt: (plain) => this.secrets.encrypt(plain),
        inbox, changed: (kind, id) => this.events.publish(kind, id), day: kyivDay,
        log: (m) => this.logger.warn(m),
      }, new Date());
      this.logger.log(`connections: Threads refreshed ${r.threadsRefreshed}, failed ${r.threadsFailed}, expired ${r.threadsExpired}; Meta inspected ${r.metaInspected}; broken bots ${r.botsBroken}, Telegraph ${r.telegraphBroken}; TikTok failed ${r.tiktokFailed}; alerts ${r.alerts}`);
    } catch (err: any) {
      this.logger.warn(`connection keeper failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }
}
