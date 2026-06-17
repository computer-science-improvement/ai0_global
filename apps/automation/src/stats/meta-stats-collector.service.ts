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
import { MetaAccountInsightsRepository } from './meta-account-insights.repository';
import { SecretsService } from '../common/crypto/secrets.service';

@Injectable()
export class MetaStatsCollectorService {
  private readonly logger = new Logger(MetaStatsCollectorService.name);
  private running = false;

  constructor(
    private readonly accounts: MetaAccountsRepository,
    private readonly graph:    MetaGraphClient,
    private readonly history:  MetaFollowerHistoryRepository,
    private readonly insights: MetaAccountInsightsRepository,
    private readonly config:   ConfigService,
    private readonly secrets:  SecretsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async hourly(): Promise<void> { await this.runOnce(); }

  async runOnce(): Promise<{ accounts: number; snapshots: number; insightDays: number }> {
    if (this.running) {
      this.logger.warn('Meta collector already running — skip');
      return { accounts: 0, snapshots: 0, insightDays: 0 };
    }
    this.running = true;
    let n = 0;
    let snaps = 0;
    let insightDays = 0;
    try {
      const active = (await this.accounts.list()).filter(a => a.active);
      for (const a of active) {
        try {
          const token = this.secrets.resolveToken(
            { enc: a.token_enc, env: a.token_env }, (k) => this.config.get<string>(k),
          );
          if (!token) {
            this.logger.debug(`Meta collector: ${a.token_env} not set — skipping ${a.id}`);
            continue;
          }
          // Count only accounts we actually attempt (have a token) — so a
          // no-token skip (accounts:0) reads differently from a null-followers
          // account (accounts:1) in the summary log + return value.
          n++;
          const r = await this.graph.verify(a.platform, a.target_id, token);
          // Threads has no follower count in its profile fields — fetch it from
          // the insights API instead (total_value, needs threads_manage_insights).
          let followers = r.followers;
          if (followers == null && a.platform === 'threads') {
            followers = await this.graph.fetchThreadsFollowers(a.target_id, token);
          }
          await this.accounts.markVerified(a.id, {
            username: r.username, display_name: r.displayName,
            followers, picture_url: r.pictureUrl,
          });
          if (typeof followers === 'number') {
            await this.history.insert(a.id, followers);
            snaps++;
          }
          try {
            const days = await this.graph.fetchInsights(a.platform, a.target_id, token);
            for (const d of days) {
              await this.insights.upsertDay(a.id, d.day, { reach: d.reach, impressions: d.impressions, profileViews: d.profileViews });
              insightDays++;
            }
          } catch (err: any) {
            this.logger.warn(`Meta collector: insights for ${a.id} failed: ${err.message}`);
          }
        } catch (err: any) {
          this.logger.warn(`Meta collector: account ${a.id} failed: ${err.message}`);
          try { await this.accounts.markVerifyError(a.id, err.message); } catch { /* best-effort */ }
        }
      }
      this.logger.log(`Meta collector: ${snaps} follower snapshots, ${insightDays} insight-days across ${n} accounts`);
      return { accounts: n, snapshots: snaps, insightDays };
    } finally {
      this.running = false;
    }
  }
}
