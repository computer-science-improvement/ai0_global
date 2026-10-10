import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { OwnerInbox } from '../editor/agents/owner-inbox';
import { TelegramNotifier } from '../publishers/telegram-notifier.service';
import { SponsorOrdersRepository } from './sponsor-orders.repository';
import { runStuckCheck } from './stuck-ad-orders';

/** Startup delay: the check never competes with the boot (and a crash loop never spams the owner). */
const BOOT_DELAY_MS = 90_000;

/**
 * Spec 036: paid ad orders that were not published are flagged and posted to the Inbox — once after every
 * start (the backlog left by earlier releases) and daily. Read + flag only: nothing is refunded or published.
 * AD_STUCK_CHECK=off disables it.
 */
@Injectable()
export class StuckAdOrdersUpkeep implements OnApplicationBootstrap {
  private readonly logger = new Logger('StuckAdOrders');
  private running = false;

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly notifier: TelegramNotifier,
    private readonly config: ConfigService,
  ) {}

  private enabled(): boolean { return this.config.get<string>('AD_STUCK_CHECK') !== 'off'; }

  onApplicationBootstrap(): void {
    if (!this.enabled()) return;
    setTimeout(() => { void this.tick(); }, BOOT_DELAY_MS).unref?.();
  }

  @Cron('27 9 * * *', { name: 'stuck-ad-orders' })
  async tick(): Promise<void> {
    if (this.running || !this.enabled()) return;
    this.running = true;
    try {
      const inbox = new OwnerInbox(this.pool, (t) => this.notifier.notifyAlert(t), this.config.get<string>('DASHBOARD_URL') ?? null);
      const fresh = await runStuckCheck({ orders: new SponsorOrdersRepository(this.pool), inbox, log: (m) => this.logger.warn(m) }, new Date());
      if (fresh.length) this.logger.warn(`${fresh.length} paid ad order(s) not published — posted to the Inbox`);
    } catch (err: any) {
      this.logger.warn(`stuck ad orders check failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }
}
