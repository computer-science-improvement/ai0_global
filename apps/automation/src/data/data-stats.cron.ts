import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Pool } from 'pg';
import { DB_POOL } from '../database/database.tokens';
import { DataStore } from './data-store';

/**
 * Spec 032 FR-010: the agent catalog reads `data_schema_stats`. Imports refresh their own dataset; this
 * job recomputes every dataset nightly (today-items change at midnight Kyiv; posted markers change all day).
 */
@Injectable()
export class DataStatsCron {
  private readonly logger = new Logger('DataStats');
  private readonly store: DataStore;

  constructor(@Inject(DB_POOL) pool: Pool) {
    this.store = new DataStore(pool);
  }

  @Cron('5 0 * * *', { name: 'data-schema-stats', timeZone: 'Europe/Kyiv' })
  async refresh(): Promise<number> {
    try {
      const n = await this.store.refreshStats();
      this.logger.log(`data_schema_stats refreshed for ${n} datasets`);
      return n;
    } catch (err: any) {
      this.logger.warn(`data_schema_stats refresh failed: ${err?.message ?? err}`);
      return 0;
    }
  }
}
