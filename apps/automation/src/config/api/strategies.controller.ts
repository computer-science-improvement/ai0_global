// apps/automation/src/config/api/strategies.controller.ts
import {
  Body, ConflictException, Controller, Delete, Get, GoneException,
  NotFoundException, Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { StrategyBindingsRepository } from '../strategy-bindings.repository';
import { StrategyRunsRepository } from '../strategy-runs.repository';
import { MetaCrosspostTargetsRepository } from '../meta-crosspost-targets.repository';
import { ConfigCacheService } from '../config-cache.service';
import { ConfigEventsPublisher } from '../config-events.publisher';
import { MetaAccountsRepository } from '../meta-accounts.repository';
import { PatchStrategyDto } from './dto/strategies.dto';

/** The 410 body of every removed strategies endpoint (spec 023 FR-013). */
export function strategiesGone(details: string): GoneException {
  return new GoneException({ error: 'strategies_legacy', details });
}

const REMOVED = 'Strategies were removed (spec 023 phase B): content is run by agents. Bindings and runs are kept as history only.';

/**
 * Spec 023 FR-013 phase B: the legacy strategy runtime (scheduler, strategy modules, previews, runway counter) is
 * gone. What stays is history: the bindings list (read by the Overview, Logs, channel pages and the Meta group
 * checks) and pausing / notes, so a leftover enabled binding can still be switched off. Every other endpoint
 * answers `410 strategies_legacy`. `/api/strategies/migration*` (the binding → series migration) lives in
 * `editor/migration/strategy-migration.controller.ts` and is unaffected.
 */
@Controller('api/strategies')
@UseGuards(TrackingAuthGuard)
export class StrategiesController {
  constructor(
    private readonly repo:      StrategyBindingsRepository,
    private readonly runsRepo:  StrategyRunsRepository,
    private readonly cache:     ConfigCacheService,
    private readonly publisher: ConfigEventsPublisher,
    private readonly crossposts: MetaCrosspostTargetsRepository,
    private readonly metaAccounts: MetaAccountsRepository,
  ) {}

  /**
   * Read-only history: every binding with denormalized channel info and its last run. Nothing here runs any more,
   * so there is no next run and no content runway.
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
    return rows.map(r => {
      const metaAccount = r.meta_account_id ? metaById.get(r.meta_account_id) : undefined;
      const channel = r.channel_id ? this.cache.getChannelById(r.channel_id) : null;
      const last    = latestByStrategy.get(r.id);
      // Channels this binding reached: the primary channel + forward-route targets of it.
      const forwards = r.channel_id ? this.cache.getForwardRoutesForSource(r.channel_id) : [];
      const channels: Array<{ id: string; channel_key: string | null; title: string | null; role: 'primary' | 'forward' }> = [];
      if (channel) {
        channels.push({ id: channel.id, channel_key: channel.channel_key, title: channel.title, role: 'primary' });
      }
      for (const f of forwards) {
        const t = this.cache.getChannelById(f.target_channel_id);
        if (!t) continue;
        channels.push({ id: t.id, channel_key: t.channel_key, title: t.title, role: 'forward' });
      }
      return {
        id:           r.id,
        ext_id:       r.ext_id,
        type:         r.type,
        channel_id:   r.channel_id,
        channel_key:  channel?.channel_key ?? null,
        channels,
        // True when this telegram binding's channel has no bot bound AND there is no default bot.
        needs_bot:    r.platform === 'telegram'
          ? (!channel?.bot_id && this.cache.getDefaultBot() === null)
          : false,
        platform:     r.platform,
        meta_account: metaAccount
          ? { id: metaAccount.id, platform: metaAccount.platform, username: metaAccount.username }
          : null,
        platforms:    r.platform === 'telegram'
          ? ['telegram', ...(r.channel_id ? (crosspostPlatforms.get(r.channel_id) ?? []) : [])]
          : [r.platform],
        schedule:     r.schedule,
        params:       r.params,
        enabled:      r.enabled,
        notes:        r.notes,
        retired_at:     r.retired_at ?? null,
        retired_reason: r.retired_reason ?? null,
        migrated_to:    r.migrated_to ?? null,
        last_run:     last ? {
          status:      last.status,
          started_at:  last.started_at,
          finished_at: last.finished_at,
          duration_ms: last.duration_ms,
          error:       last.error,
        } : null,
      };
    });
  }

  @Get('types')
  listTypes(): never { throw strategiesGone(REMOVED); }

  @Get(':id/runs')
  runs(@Param('id') _id: string): never { throw strategiesGone(`${REMOVED} Run history is on the Logs page.`); }

  @Get(':id/preview')
  previewStrategy(@Param('id') _id: string): never { throw strategiesGone(REMOVED); }

  @Get(':id/post-preview')
  postPreview(@Param('id') _id: string): never { throw strategiesGone(REMOVED); }

  @Post()
  create(@Body() _body: unknown): never {
    throw strategiesGone('Strategies are legacy: content is run by agents. Create or configure an agent instead.');
  }

  /** History is kept: a binding is never deleted any more (pause it instead). */
  @Delete(':id')
  remove(@Param('id') _id: string): never {
    throw strategiesGone(`${REMOVED} Pause the binding instead of deleting it.`);
  }

  /**
   * Only pausing (`enabled: false`) and `notes` may change. Enabling is closed (a retired binding answers
   * 409 binding_retired: strategies no longer run, spec 023 phase B); every other field is refused.
   */
  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: PatchStrategyDto) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException(`Strategy ${id} not found`);

    // Spec 023 FR-012 + phase B: a binding retired by a cutover is the agent's now and stays retired.
    if (body?.enabled === true && existing.retired_at) {
      const to = existing.migrated_to?.handle ? ` to @${existing.migrated_to.handle}` : '';
      throw new ConflictException({
        error: 'binding_retired',
        details: `${existing.ext_id} was retired by the migration${to}; strategies no longer run, so it stays retired: the agent writes this channel`,
        migrated_to: existing.migrated_to ?? null,
      });
    }
    const refused = Object.entries(body ?? {})
      .filter(([k, v]) => v !== undefined && !(k === 'notes' || (k === 'enabled' && v === false)))
      .map(([k]) => k);
    if (refused.length) {
      throw new GoneException({
        error: 'strategies_legacy',
        details: `Strategies are legacy and no longer run: only pausing (enabled: false) and notes can change (refused: ${refused.join(', ')}). Content is run by agents.`,
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
}
