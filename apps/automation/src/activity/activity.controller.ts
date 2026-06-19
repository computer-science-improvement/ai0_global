import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { ActivityService } from './activity.service';
import { StrategyRunsRepository } from '../config/strategy-runs.repository';
import type { ActivityType } from './activity.repository';

const TYPES: ActivityType[] = ['posted', 'error', 'skipped', 'running'];

@Controller('activity')
@UseGuards(TrackingAuthGuard)
export class ActivityController {
  constructor(
    private readonly activity: ActivityService,
    private readonly runs:     StrategyRunsRepository,
  ) {}

  @Get()
  list(
    @Query('platform') platform = 'telegram',
    @Query('type')     type?: string,
    @Query('from')     from?: string,
    @Query('to')       to?: string,
    @Query('strategy') strategy?: string,
    @Query('channelId') channelId?: string,
    @Query('limit')    limit?: string,
    @Query('offset')   offset?: string,
  ) {
    const t = TYPES.includes(type as ActivityType) ? (type as ActivityType) : null;
    const lim = Math.min(200, Math.max(1, parseInt(limit ?? '50', 10) || 50));
    const off = Math.max(0, parseInt(offset ?? '0', 10) || 0);
    return this.activity.list({
      platform, type: t,
      from: from || null, to: to || null,
      strategy: strategy || null, channelId: channelId || null,
      limit: lim, offset: off,
    });
  }

  /** Lazy-loaded execution trace for a strategy run (when a log row expands). */
  @Get('run/:runId/steps')
  steps(@Param('runId') runId: string) {
    return this.runs.stepsFor(runId);
  }
}
