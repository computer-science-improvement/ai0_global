// apps/automation/src/config/api/strategies.controller.ts
import {
  Body, ConflictException, Controller, Delete, Get, GoneException,
  HttpCode, NotFoundException, Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import { makeCronJob } from '../../scheduler/schedule-time-zone';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { StrategyBindingsRepository } from '../strategy-bindings.repository';
import { StrategyRunsRepository } from '../strategy-runs.repository';
import { MetaCrosspostTargetsRepository } from '../meta-crosspost-targets.repository';
import { StrategyPreviewService } from '../strategy-preview.service';
import { ConfigCacheService } from '../config-cache.service';
import { ConfigEventsPublisher } from '../config-events.publisher';
import { ContentRunwayService } from '../../common/content-runway/content-runway.service';
import { bindingPostedKey } from '../../common/content-strategy/publish-destination';
import { MetaAccountsRepository } from '../meta-accounts.repository';
import { ContentStrategyRegistry } from '../../common/content-strategy/content-strategy.registry';
import { TikTokAccountsRepository } from '../tiktok-accounts.repository';
import { PatchStrategyDto } from './dto/strategies.dto';

/**
 * Compute the next-run timestamp for a schedule. Returns ISO string or null
 * if the cron expression is invalid. Used by the list endpoint so the UI
 * can render "next in 2h 34m" without re-parsing on the client.
 */
function nextRunOrNull(schedule: string): string | null {
  try {
    const job = makeCronJob(schedule, () => {}); // same zone as the scheduler
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
        // True when this telegram binding's channel has no bot bound AND there
        // is no default bot to fall back to — publishing would stop. Non-telegram
        // bindings publish via Meta/TikTok accounts, never a bot, so always false.
        needs_bot:    r.platform === 'telegram'
          ? (!channel?.bot_id && this.cache.getDefaultBot() === null)
          : false,
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
        // Spec 023 FR-013: a binding retired by a cutover (greyed in the UI, linked to the agent's series).
        retired_at:     r.retired_at ?? null,
        retired_reason: r.retired_reason ?? null,
        migrated_to:    r.migrated_to ?? null,
        next_run_at:  r.enabled ? nextRunOrNull(r.schedule) : null,
        last_run:     last ? {
          status:      last.status,
          started_at:  last.started_at,
          finished_at: last.finished_at,
          duration_ms: last.duration_ms,
          error:       last.error,
        } : null,
        content_remaining:     await this.runway.remainingFor(
          r.type, channel?.channel_key ?? r.channel_id, r.params,
          bindingPostedKey(r.platform, metaAccount?.platform ?? null, r.meta_account_id, r.tiktok_account_id),
        ),
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

  /** Caption parts + per-platform rendered captions for a recipe-carousel
   *  binding — drives the editable Post-Preview. 404 for non-recipe bindings. */
  @Get(':id/post-preview')
  async postPreview(@Param('id') id: string) {
    const preview = await this.preview.recipePostPreview(id);
    if (!preview) throw new NotFoundException('Post-preview only available for recipe-carousel strategies');
    return preview;
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

  /**
   * Spec 023 FR-013 phase A: strategies are read-only legacy — content is run by agents. No new binding;
   * migrate a channel instead (Strategies → Migrate, or @ai0).
   */
  @Post()
  create(@Body() _body: unknown): never {
    throw new GoneException({
      error: 'strategies_legacy',
      details: 'Strategies are legacy: content is run by agents. Migrate the channel on /app/strategies or create an agent.',
    });
  }

  /**
   * Phase A: only pausing (`enabled: false`) and `notes` may change. Enabling is closed (a retired binding
   * answers 409 binding_retired; the rollback card is the only way back); every other field is refused.
   */
  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: PatchStrategyDto) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException(`Strategy ${id} not found`);

    // Spec 023 FR-012: a binding retired by a cutover is the agent's now; only the rollback card brings it back.
    if (body?.enabled === true && existing.retired_at) {
      const to = existing.migrated_to?.handle ? ` to @${existing.migrated_to.handle}` : '';
      throw new ConflictException({
        error: 'binding_retired',
        details: `${existing.ext_id} was retired by the migration${to}; use the Rollback card on /app/strategies to restore it`,
        migrated_to: existing.migrated_to ?? null,
      });
    }
    const refused = Object.entries(body ?? {})
      .filter(([k, v]) => v !== undefined && !(k === 'notes' || (k === 'enabled' && v === false)))
      .map(([k]) => k);
    if (refused.length) {
      throw new GoneException({
        error: 'strategies_legacy',
        details: `Strategies are read-only legacy: only pausing (enabled: false) and notes can change (refused: ${refused.join(', ')}). Migrate the channel to an agent instead.`,
        refused,
      });
    }

    const updated = await this.repo.update(id, {
      ...(body.enabled === false ? { enabled: false } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
    });
    if (body.enabled === false) await this.publisher.publish('strategy', id);
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
