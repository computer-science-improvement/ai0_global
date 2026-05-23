// apps/automation/src/config/api/strategies.controller.ts
import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get,
  HttpCode, NotFoundException, Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import { CronJob } from 'cron';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { StrategyBindingsRepository } from '../strategy-bindings.repository';
import { StrategyRunsRepository } from '../strategy-runs.repository';
import { ConfigCacheService } from '../config-cache.service';
import { ConfigEventsPublisher } from '../config-events.publisher';
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

@Controller('api/strategies')
@UseGuards(TrackingAuthGuard)
export class StrategiesController {
  constructor(
    private readonly repo:      StrategyBindingsRepository,
    private readonly runsRepo:  StrategyRunsRepository,
    private readonly cache:     ConfigCacheService,
    private readonly publisher: ConfigEventsPublisher,
  ) {}

  /**
   * List all strategies with denormalized channel info so the UI doesn't
   * have to fan out N requests. `next_run_at` is server-computed via the
   * `cron` lib — the same lib SchedulerService uses, so the values agree.
   * `last_run` is the most recent run row (or null) per strategy.
   */
  @Get()
  async list() {
    const [rows, latestByStrategy] = await Promise.all([
      this.repo.list(),
      this.runsRepo.latestPerStrategy(),
    ]);
    return rows.map(r => {
      const channel = this.cache.getChannelById(r.channel_id);
      const last    = latestByStrategy.get(r.id);
      return {
        id:           r.id,
        ext_id:       r.ext_id,
        type:         r.type,
        channel_id:   r.channel_id,
        channel_key:  channel?.channel_key ?? null,
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
      };
    });
  }

  /** Recent execution log for one strategy. */
  @Get(':id/runs')
  async runs(@Param('id') id: string) {
    return this.runsRepo.recent(id, 20);
  }

  @Post()
  async create(@Body() body: CreateStrategyDto) {
    assertCronOrThrow(body.schedule);

    const existing = await this.repo.findByExtId(body.ext_id);
    if (existing) throw new ConflictException(`ext_id ${body.ext_id} already exists`);

    // Channel must exist — cache is authoritative source of truth.
    if (!this.cache.getChannelById(body.channel_id)) {
      throw new BadRequestException(`channel_id ${body.channel_id} not found`);
    }

    const row = await this.repo.insert({
      ext_id:     body.ext_id,
      type:       body.type,
      channel_id: body.channel_id,
      schedule:   body.schedule,
      params:     body.params ?? {},
      enabled:    body.enabled ?? true,
    });
    await this.publisher.publish('strategy', row.id);
    return row;
  }

  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: PatchStrategyDto) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException(`Strategy ${id} not found`);

    if (body.schedule !== undefined) assertCronOrThrow(body.schedule);
    if (body.channel_id !== undefined && !this.cache.getChannelById(body.channel_id)) {
      throw new BadRequestException(`channel_id ${body.channel_id} not found`);
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
