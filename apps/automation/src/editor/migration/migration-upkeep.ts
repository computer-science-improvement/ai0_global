import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { offerCutovers } from './migration-actions';
import { STRATEGY_MIGRATION, type StrategyMigrationInfra } from './strategy-migration.controller';

/** Daily cutover offers (spec 023 FR-012): a chatless card plus an Inbox item; never a mode change by itself. */
@Injectable()
export class StrategyMigrationUpkeep {
  private readonly logger = new Logger('StrategyMigration');

  constructor(@Inject(STRATEGY_MIGRATION) private readonly m: StrategyMigrationInfra) {}

  @Cron('41 6 * * *', { name: 'strategy-cutover-offers' })
  async offer(): Promise<void> {
    try {
      const n = await offerCutovers({ svc: this.m.svc, actions: this.m.actions, inbox: this.m.inbox, pool: this.m.pool });
      if (n) this.logger.log(`strategy cutover offered on ${n} channel(s)`);
    } catch (err: any) {
      this.logger.warn(`strategy cutover offers failed: ${err?.message ?? err}`);
    }
  }
}
