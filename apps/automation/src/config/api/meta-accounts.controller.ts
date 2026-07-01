// apps/automation/src/config/api/meta-accounts.controller.ts
import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get,
  HttpCode, NotFoundException, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { MetaAccountsRepository, type MetaAccountRow } from '../meta-accounts.repository';
import { MetaGraphClient } from '../meta-graph.client';
import { MetaFollowerHistoryRepository } from '../../stats/meta-follower-history.repository';
import { MetaAccountInsightsRepository } from '../../stats/meta-account-insights.repository';
import { MetaStatsCollectorService } from '../../stats/meta-stats-collector.service';
import { StrategyBindingsRepository } from '../strategy-bindings.repository';
import { ConfigEventsPublisher } from '../config-events.publisher';
import { SecretsService } from '../../common/crypto/secrets.service';
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
    private readonly bindings:  StrategyBindingsRepository,
    private readonly publisher: ConfigEventsPublisher,
    private readonly secrets:   SecretsService,
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
    return rows.map(r => this.toListItem(r, deltas.get(r.id) ?? null));
  }

  /** Public projection of an account row. NEVER includes token_enc (the
   *  encrypted secret) — only the env-var NAME and derived token metadata. */
  private toListItem(r: MetaAccountRow, followersDelta24h: number | null = null) {
    return {
      id: r.id, platform: r.platform, account_id: r.account_id,
      token_env: r.token_env, target_id: r.target_id,
      username: r.username, display_name: r.display_name,
      followers: r.followers, picture_url: r.picture_url,
      followers_delta_24h: followersDelta24h,
      active: r.active, last_verified_at: r.last_verified_at,
      verify_error: r.verify_error, created_at: r.created_at,
      group_id: r.group_id,
      // Derived token metadata only — never the token value.
      token_type: r.token_type, token_expires_at: r.token_expires_at,
      token_data_access_expires_at: r.token_data_access_expires_at,
      token_scopes: r.token_scopes, token_valid: r.token_valid,
      token_checked_at: r.token_checked_at,
    };
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
    if (!body.token && !body.tokenEnv) {
      throw new BadRequestException('provide a token value or an env var name');
    }
    const existing = await this.accounts.findByPlatformAccount(body.platform, body.accountId);
    if (existing) throw new ConflictException(`${body.platform} account ${body.accountId} already exists`);
    // A token VALUE is encrypted into token_enc; the token itself is never stored
    // in plaintext, logged, or echoed back. The env-var NAME (legacy) is stored as-is.
    const tokenEnc = body.token ? this.secrets.encrypt(body.token.trim()) : null;
    const row = await this.accounts.insert({
      platform: body.platform, account_id: body.accountId,
      token_env: body.tokenEnv ?? null, token_enc: tokenEnc, target_id: body.targetId,
    });
    return this.toListItem(row);
  }

  @Post(':id/refresh-threads-token')
  async refreshThreadsToken(@Param('id') id: string) {
    const acc = await this.accounts.findById(id);
    if (!acc) throw new NotFoundException(`Meta account ${id} not found`);
    if (acc.platform !== 'threads') {
      throw new BadRequestException('refresh-threads-token is only valid for threads accounts');
    }

    const token = this.secrets.resolveToken(
      { enc: acc.token_enc, env: acc.token_env }, (k) => this.env.get<string>(k),
    );
    if (!token) throw new BadRequestException('no token to refresh');

    const { accessToken, expiresInSec } = await this.graph.refreshThreadsToken(token);

    // Persist the NEW token encrypted, and record the new expiry so the UI's
    // token-info card reflects it (token_checked_at is set by setTokenMeta).
    const enc = this.secrets.encrypt(accessToken);
    await this.accounts.setTokenEnc(id, enc);
    const expiresAt = new Date(Date.now() + expiresInSec * 1000);
    await this.accounts.setTokenMeta(id, {
      type: 'THREADS', expiresAt, dataAccessExpiresAt: null, scopes: [], isValid: true,
    });

    // Never return the token value — only the new expiry.
    return { ok: true, expiresAt };
  }

  @Post(':id/verify')
  async verify(@Param('id') id: string) {
    const acc = await this.accounts.findById(id);
    if (!acc) throw new NotFoundException(`Meta account ${id} not found`);

    const token = this.secrets.resolveToken(
      { enc: acc.token_enc, env: acc.token_env }, (k) => this.env.get<string>(k),
    );
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
      // Threads `/me` returns the token's authoritative user id — persist it so a
      // wrong/stale target id self-heals and publishing uses the correct node.
      if (r.resolvedTargetId && r.resolvedTargetId !== acc.target_id) {
        await this.accounts.setTargetId(id, r.resolvedTargetId);
      }
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
    if (body.groupId !== undefined) {
      try {
        await this.accounts.setGroup(id, body.groupId);
      } catch (err: any) {
        // Partial unique index (group_id, platform): a group already has an
        // account of this platform.
        if (err?.code === '23505') {
          throw new ConflictException(
            `That group already has a ${acc.platform} account — one per platform per group.`,
          );
        }
        throw err;
      }
    }
    return { ok: true };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Query('cascade') cascade?: string) {
    const acc = await this.accounts.findById(id);
    if (!acc) throw new NotFoundException(`Meta account ${id} not found`);

    const bound = await this.bindings.listByMetaAccount(id);
    if (bound.length > 0 && cascade !== 'true') {
      // Clean 409 instead of a raw FK 500 — the dashboard lists these and
      // re-submits with ?cascade=true once the operator confirms.
      throw new ConflictException(
        `Account is used by ${bound.length} strateg${bound.length === 1 ? 'y' : 'ies'}: ` +
        `${bound.map(b => b.ext_id).join(', ')}. Confirm cascade delete.`,
      );
    }

    if (bound.length > 0) {
      // Delete bindings BEFORE the account so the FK is satisfied, then publish
      // a reload so the scheduler reconciles (drops the removed bindings).
      await this.bindings.deleteByMetaAccount(id);
      await this.publisher.publish('strategy', id);
    }

    const ok = await this.accounts.delete(id);
    if (!ok) throw new NotFoundException(`Meta account ${id} not found`);
  }
}
