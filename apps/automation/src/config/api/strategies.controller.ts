// apps/automation/src/config/api/strategies.controller.ts
import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get,
  HttpCode, NotFoundException, Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import { CronJob } from 'cron';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { StrategyBindingsRepository } from '../strategy-bindings.repository';
import { StrategyRunsRepository } from '../strategy-runs.repository';
import { MetaCrosspostTargetsRepository } from '../meta-crosspost-targets.repository';
import { StrategyPreviewService } from '../strategy-preview.service';
import { ConfigCacheService } from '../config-cache.service';
import { ConfigEventsPublisher } from '../config-events.publisher';
import { ContentRunwayService } from '../../common/content-runway/content-runway.service';
import { MetaAccountsRepository } from '../meta-accounts.repository';
import { ContentStrategyRegistry } from '../../common/content-strategy/content-strategy.registry';
import { TikTokAccountsRepository } from '../tiktok-accounts.repository';
import { CreateStrategyDto, PatchStrategyDto } from './dto/strategies.dto';

/**
 * Schema validation for cron expressions. The `cron` lib throws a
 * descriptive error on parse failure; we re-wrap into 400.
 */
function assertCronOrThrow(schedule: string): void {
  try {
    new CronJob(schedule, () => {});
  } catch (err: any) {
    throw new BadRequestException(`Invalid cron expression: ${err?.message ?? schedule}`);
  }
}

/**
 * Compute the next-run timestamp for a schedule. Returns ISO string or null
 * if the cron expression is invalid. Used by the list endpoint so the UI
 * can render "next in 2h 34m" without re-parsing on the client.
 */
function nextRunOrNull(schedule: string): string | null {
  try {
    const job = new CronJob(schedule, () => {});
    const next = job.nextDate(); // Luxon DateTime
    return next.toJSDate().toISOString();
  } catch {
    return null;
  }
}

/**
 * Strategy types hidden from the create/edit selects. They stay registered and
 * keep running for existing bindings — they're just not offered when adding a
 * new strategy (operator decision, not a capability change).
 */
const HIDDEN_STRATEGY_TYPES = new Set(['daily-photo', 'ua-news', 'movies']);

@Controller('api/strategies')
@UseGuards(TrackingAuthGuard)
export class StrategiesController {
  constructor(
    private readonly repo:      StrategyBindingsRepository,
    private readonly runsRepo:  StrategyRunsRepository,
    private readonly preview:   StrategyPreviewService,
    private readonly cache:     ConfigCacheService,
    private readonly publisher: ConfigEventsPublisher,
    private readonly crossposts: MetaCrosspostTargetsRepository,
    private readonly runway:    ContentRunwayService,
    private readonly metaAccounts: MetaAccountsRepository,
    private readonly registry: ContentStrategyRegistry,
    private readonly tiktokAccounts: TikTokAccountsRepository,
  ) {}

  /**
   * List all strategies with denormalized channel info so the UI doesn't
   * have to fan out N requests. `next_run_at` is server-computed via the
   * `cron` lib — the same lib SchedulerService uses, so the values agree.
   * `last_run` is the most recent run row (or null) per strategy.
   */
  @Get()
  async list() {
    const [rows, latestByStrategy, crosspostPlatforms, metaAccountList] = await Promise.all([
      this.repo.list(),
      this.runsRepo.latestPerStrategy(),
      this.crossposts.platformsByChannel(),
      this.metaAccounts.list(),
    ]);
    const metaById = new Map(metaAccountList.map(a => [a.id, a]));
    return Promise.all(rows.map(async r => {
      // The binding's own destination, used so the UI can show the right
      // platform icon + group native-Meta strategies under the Meta tab.
      const metaAccount = r.meta_account_id ? metaById.get(r.meta_account_id) : undefined;
      const channel = r.channel_id ? this.cache.getChannelById(r.channel_id) : null;
      const last    = latestByStrategy.get(r.id);
      // Channels this strategy actually reaches: primary binding + forward
      // route targets that originate from the primary channel.
      const forwards = r.channel_id ? this.cache.getForwardRoutesForSource(r.channel_id) : [];
      const channels: Array<{ id: string; channel_key: string | null; title: string | null; role: 'primary' | 'forward' }> = [];
      if (channel) {
        channels.push({
          id:          channel.id,
          channel_key: channel.channel_key,
          title:       channel.title,
          role:        'primary',
        });
      }
      for (const f of forwards) {
        const t = this.cache.getChannelById(f.target_channel_id);
        if (!t) continue;
        channels.push({
          id:          t.id,
          channel_key: t.channel_key,
          title:       t.title,
          role:        'forward',
        });
      }
      return {
        id:           r.id,
        ext_id:       r.ext_id,
        type:         r.type,
        channel_id:   r.channel_id,
        channel_key:  channel?.channel_key ?? null,
        channels,
        // Destination kind of THIS binding (telegram | instagram | facebook | threads).
        platform:     r.platform,
        // Meta account this binding publishes to (null for telegram bindings).
        meta_account: metaAccount
          ? { id: metaAccount.id, platform: metaAccount.platform, username: metaAccount.username }
          : null,
        // Icons + tab grouping. A telegram binding shows telegram + its cross-post
        // targets; a native-Meta binding shows only its own platform.
        platforms:    r.platform === 'telegram'
          ? ['telegram', ...(r.channel_id ? (crosspostPlatforms.get(r.channel_id) ?? []) : [])]
          : [r.platform],
        schedule:     r.schedule,
        params:       r.params,
        enabled:      r.enabled,
        notes:        r.notes,
        next_run_at:  r.enabled ? nextRunOrNull(r.schedule) : null,
        last_run:     last ? {
          status:      last.status,
          started_at:  last.started_at,
          finished_at: last.finished_at,
          duration_ms: last.duration_ms,
          error:       last.error,
        } : null,
        content_remaining:     await this.runway.remainingFor(r.type, channel?.channel_key ?? r.channel_id, r.params),
        low_content_threshold: this.runway.effectiveThreshold(r.low_content_threshold),
      };
    }));
  }

  @Get('types')
  listTypes() {
    return this.registry.types()
      .filter(type => !HIDDEN_STRATEGY_TYPES.has(type))
      .map(type => ({
        type,
        supportedPlatforms: this.registry.supportedPlatforms(type),
      }));
  }

  /** Recent execution log for one strategy. */
  @Get(':id/runs')
  async runs(@Param('id') id: string) {
    return this.runsRepo.recent(id, 20);
  }

  /**
   * Sample of what this strategy would publish next — the next un-posted
   * DB row for table-backed strategies, the recent dedup log for feed-driven
   * ones, or a "live-fetch" marker for pure-API types. Best-effort: failures
   * surface as `kind: 'unsupported'` rather than 500.
   */
  @Get(':id/preview')
  async previewStrategy(@Param('id') id: string) {
    const result = await this.preview.previewById(id);
    if (!result) throw new NotFoundException(`Strategy ${id} not found`);
    return result;
  }

  @Post()
  async create(@Body() body: CreateStrategyDto) {
    assertCronOrThrow(body.schedule);

    const existing = await this.repo.findByExtId(body.ext_id);
    if (existing) throw new ConflictException(`ext_id ${body.ext_id} already exists`);

    const platform = body.platform ?? 'telegram';
    const supported = this.registry.supportedPlatforms(body.type);
    if (!supported.includes(platform)) {
      throw new BadRequestException(`strategy ${body.type} does not support platform ${platform}`);
    }

    if (platform === 'telegram') {
      if (!body.channel_id) throw new BadRequestException('channel_id is required for a telegram binding');
      if (!this.cache.getChannelById(body.channel_id)) throw new BadRequestException(`channel_id ${body.channel_id} not found`);
      if (body.meta_account_id) throw new BadRequestException('telegram binding must not set meta_account_id');
      if (body.tiktok_account_id) throw new BadRequestException('telegram binding must not set tiktok_account_id');
    } else if (platform === 'tiktok') {
      if (!body.tiktok_account_id) throw new BadRequestException('tiktok_account_id is required for a tiktok binding');
      const acct = await this.tiktokAccounts.findById(body.tiktok_account_id);
      if (!acct) throw new BadRequestException(`tiktok account ${body.tiktok_account_id} not found`);
      if (body.channel_id) throw new BadRequestException('tiktok binding must not set channel_id');
      if (body.meta_account_id) throw new BadRequestException('tiktok binding must not set meta_account_id');
    } else {
      if (!body.meta_account_id) throw new BadRequestException('meta_account_id is required for a meta binding');
      const acct = await this.metaAccounts.findById(body.meta_account_id);
      if (!acct) throw new BadRequestException(`meta account ${body.meta_account_id} not found`);
      if (body.channel_id) throw new BadRequestException('meta binding must not set channel_id');
      if (body.tiktok_account_id) throw new BadRequestException('meta binding must not set tiktok_account_id');
    }

    const row = await this.repo.insert({
      ext_id:     body.ext_id,
      type:       body.type,
      channel_id: platform === 'telegram' ? body.channel_id! : null,
      schedule:   body.schedule,
      params:     body.params ?? {},
      enabled:    body.enabled ?? false, // default paused — never auto-publish a freshly created strategy
      platform,
      meta_account_id: (platform === 'instagram' || platform === 'facebook' || platform === 'threads') ? body.meta_account_id! : null,
      tiktok_account_id: platform === 'tiktok' ? body.tiktok_account_id! : null,
    });
    await this.publisher.publish('strategy', row.id);
    return row;
  }

  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: PatchStrategyDto) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException(`Strategy ${id} not found`);

    // Renaming the logical slug: enforce uniqueness server-side. A no-op set
    // (same value as existing) is allowed and skips the lookup.
    if (body.ext_id !== undefined && body.ext_id !== existing.ext_id) {
      const dup = await this.repo.findByExtId(body.ext_id);
      if (dup && dup.id !== id) throw new ConflictException(`ext_id ${body.ext_id} already exists`);
    }

    if (body.schedule !== undefined) assertCronOrThrow(body.schedule);
    if (body.channel_id !== undefined && !this.cache.getChannelById(body.channel_id)) {
      throw new BadRequestException(`channel_id ${body.channel_id} not found`);
    }
    if (body.meta_account_id !== undefined && body.meta_account_id !== null) {
      const acct = await this.metaAccounts.findById(body.meta_account_id);
      if (!acct) throw new BadRequestException(`meta account ${body.meta_account_id} not found`);
    }
    if (body.channel_id !== undefined && body.meta_account_id !== undefined) {
      throw new BadRequestException('cannot set both channel_id and meta_account_id');
    }
    // TikTok destination — mirror create()'s validation so a patch can't persist an
    // invalid binding (unknown account / incompatible platform / multiple destinations).
    if (body.tiktok_account_id !== undefined && body.tiktok_account_id !== null) {
      const acct = await this.tiktokAccounts.findById(body.tiktok_account_id);
      if (!acct) throw new BadRequestException(`tiktok account ${body.tiktok_account_id} not found`);
      if (body.channel_id !== undefined) throw new BadRequestException('cannot set both channel_id and tiktok_account_id');
      if (body.meta_account_id !== undefined) throw new BadRequestException('cannot set both meta_account_id and tiktok_account_id');
    }
    if (body.platform !== undefined) {
      const supported = this.registry.supportedPlatforms(body.type ?? existing.type);
      if (!supported.includes(body.platform)) {
        throw new BadRequestException(`strategy ${body.type ?? existing.type} does not support platform ${body.platform}`);
      }
    }

    const updated = await this.repo.update(id, body);
    await this.publisher.publish('strategy', id);
    return updated;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string) {
    const ok = await this.repo.delete(id);
    if (!ok) throw new NotFoundException(`Strategy ${id} not found`);
    await this.publisher.publish('strategy', id);
  }
}
