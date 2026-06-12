// meta-stats-collector.service.ts — hourly follower snapshots for Meta accounts.
// Mirrors StatsCollectorService. Reuses MetaGraphClient.verify (which already
// returns follower counts for IG/FB) and refreshes the account profile as a
// free side benefit. Threads returns followers=null → no snapshot.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MetaAccountsRepository } from '../config/meta-accounts.repository';
import { MetaGraphClient } from '../config/meta-graph.client';
import { MetaFollowerHistoryRepository } from './meta-follower-history.repository';

@Injectable()
export class MetaStatsCollectorService {
  private readonly logger = new Logger(MetaStatsCollectorService.name);
  private running = false;

  constructor(
    private readonly accounts: MetaAccountsRepository,
    private readonly graph:    MetaGraphClient,
    private readonly history:  MetaFollowerHistoryRepository,
    private readonly config:   ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async hourly(): Promise<void> { await this.runOnce(); }

  async runOnce(): Promise<{ accounts: number; snapshots: number }> {
    if (this.running) {
      this.logger.warn('Meta collector already running — skip');
      return { accounts: 0, snapshots: 0 };
    }
    this.running = true;
    let n = 0;
    let snaps = 0;
    try {
      const active = (await this.accounts.list()).filter(a => a.active);
      for (const a of active) {
        n++;
        try {
          const token = this.config.get<string>(a.token_env);
          if (!token) {
            this.logger.debug(`Meta collector: ${a.token_env} not set — skipping ${a.id}`);
            continue;
          }
          const r = await this.graph.verify(a.platform, a.target_id, token);
          await this.accounts.markVerified(a.id, {
            username: r.username, display_name: r.displayName,
            followers: r.followers, picture_url: r.pictureUrl,
          });
          if (typeof r.followers === 'number') {
            await this.history.insert(a.id, r.followers);
            snaps++;
          }
        } catch (err: any) {
          this.logger.warn(`Meta collector: account ${a.id} failed: ${err.message}`);
          try { await this.accounts.markVerifyError(a.id, err.message); } catch { /* best-effort */ }
        }
      }
      this.logger.log(`Meta collector: ${snaps} follower snapshots across ${n} accounts`);
      return { accounts: n, snapshots: snaps };
    } finally {
      this.running = false;
    }
  }
}
