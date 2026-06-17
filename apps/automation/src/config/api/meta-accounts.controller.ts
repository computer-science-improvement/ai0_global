// apps/automation/src/config/api/meta-accounts.controller.ts
import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get,
  HttpCode, NotFoundException, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { MetaAccountsRepository } from '../meta-accounts.repository';
import { MetaGraphClient } from '../meta-graph.client';
import { MetaFollowerHistoryRepository } from '../../stats/meta-follower-history.repository';
import { MetaAccountInsightsRepository } from '../../stats/meta-account-insights.repository';
import { MetaStatsCollectorService } from '../../stats/meta-stats-collector.service';
import { CreateMetaAccountDto, PatchMetaAccountDto } from './dto/meta-accounts.dto';

@Controller('api/meta-accounts')
@UseGuards(TrackingAuthGuard)
export class MetaAccountsController {
  constructor(
    private readonly accounts: MetaAccountsRepository,
    private readonly graph:    MetaGraphClient,
    private readonly env:      ConfigService,
    private readonly history:  MetaFollowerHistoryRepository,
    private readonly insights: MetaAccountInsightsRepository,
    private readonly collector: MetaStatsCollectorService,
  ) {}

  /** Dashboard-triggered manual stats refresh (followers + insights, all active
   *  accounts). Same collector the hourly cron runs; lets the operator populate
   *  charts on demand without waiting an hour. */
  @Post('refresh-stats')
  async refreshStats(): Promise<{ accounts: number; snapshots: number; insightDays: number }> {
    return this.collector.runOnce();
  }

  @Get()
  async list() {
    const [rows, deltas] = await Promise.all([
      this.accounts.list(),
      this.history.delta24hByAccount(),
    ]);
    // Never return token values — only the env-var name.
    return rows.map(r => ({
      id: r.id, platform: r.platform, account_id: r.account_id,
      token_env: r.token_env, target_id: r.target_id,
      username: r.username, display_name: r.display_name,
      followers: r.followers, picture_url: r.picture_url,
      followers_delta_24h: deltas.get(r.id) ?? null,
      active: r.active, last_verified_at: r.last_verified_at,
      verify_error: r.verify_error, created_at: r.created_at,
      // Derived token metadata only — never the token value (no token column exists).
      token_type: r.token_type, token_expires_at: r.token_expires_at,
      token_data_access_expires_at: r.token_data_access_expires_at,
      token_scopes: r.token_scopes, token_valid: r.token_valid,
      token_checked_at: r.token_checked_at,
    }));
  }

  @Get(':id/follower-history')
  async followerHistory(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const acc = await this.accounts.findById(id);
    if (!acc) throw new NotFoundException(`Meta account ${id} not found`);
    const fromD = from ? new Date(from) : undefined;
    const toD   = to   ? new Date(to)   : undefined;
    const [points, summary] = await Promise.all([
      this.history.history(id, fromD, toD),
      this.history.latestWithDelta(id),
    ]);
    return {
      accountId: id,
      current:  summary.followers,
      delta24h: summary.delta24h,
      delta7d:  summary.delta7d,
      points:   points.map(p => ({ at: p.at, followers: p.followers })),
    };
  }

  @Get(':id/insights')
  async accountInsights(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const acc = await this.accounts.findById(id);
    if (!acc) throw new NotFoundException(`Meta account ${id} not found`);
    const fromD = from ? new Date(from) : undefined;
    const toD   = to   ? new Date(to)   : undefined;
    const points = await this.insights.history(id, fromD, toD);
    return { accountId: id, points };
  }

  @Post()
  async create(@Body() body: CreateMetaAccountDto) {
    const existing = await this.accounts.findByPlatformAccount(body.platform, body.accountId);
    if (existing) throw new ConflictException(`${body.platform} account ${body.accountId} already exists`);
    return this.accounts.insert({
      platform: body.platform, account_id: body.accountId,
      token_env: body.tokenEnv, target_id: body.targetId,
    });
  }

  @Post(':id/verify')
  async verify(@Param('id') id: string) {
    const acc = await this.accounts.findById(id);
    if (!acc) throw new NotFoundException(`Meta account ${id} not found`);

    const token = this.env.get<string>(acc.token_env);
    if (!token) {
      await this.accounts.markVerifyError(id, `Env var ${acc.token_env} is not set`);
      throw new BadRequestException(`Env var ${acc.token_env} is not set`);
    }

    // Best-effort token-metadata read, INDEPENDENT of verify. debug_token only
    // needs the token (not the target), so token validity is captured even when
    // verify fails for an unrelated reason (e.g. a wrong target_id). It's a
    // facebook.com endpoint (rejects Threads tokens), and a failure must never
    // break verify.
    if (acc.platform !== 'threads') {
      const info = await this.graph.inspectToken(token);
      if (info) await this.accounts.setTokenMeta(id, info);
    }

    try {
      const r = await this.graph.verify(acc.platform, acc.target_id, token);
      await this.accounts.markVerified(id, {
        username: r.username, display_name: r.displayName,
        followers: r.followers, picture_url: r.pictureUrl,
      });
      return { ok: true, ...r };
    } catch (err: any) {
      await this.accounts.markVerifyError(id, err.message);
      return { ok: false, error: err.message };
    }
  }

  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: PatchMetaAccountDto) {
    const acc = await this.accounts.findById(id);
    if (!acc) throw new NotFoundException(`Meta account ${id} not found`);
    if (typeof body.active === 'boolean') await this.accounts.setActive(id, body.active);
    return { ok: true };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string) {
    const deleted = await this.accounts.delete(id);
    if (!deleted) throw new NotFoundException(`Meta account ${id} not found`);
  }
}
