import { Body, Controller, Get, HttpException, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { isFail, type Fail, type ScheduleScope, ScheduleService } from './schedule.service';

export const SCHEDULE_SERVICE = 'SCHEDULE_INFRA';

/** A Fail → its HTTP status with `{ error, details }`; anything else passes through. */
function http<T>(r: T | Fail): T {
  if (isFail(r)) throw new HttpException({ error: r.error, ...(r.details !== undefined ? { details: r.details } : {}) }, r.status ?? 400);
  return r;
}

/**
 * The owner's schedule (spec 023 FR-007): the Schedule tab's data, rule forms, inline series edit and
 * Unlock. Every route accepts a role child's handle too (resolved to its orchestrator).
 */
@Controller('api')
@UseGuards(TrackingAuthGuard)
export class ScheduleController {
  constructor(@Inject(SCHEDULE_SERVICE) private readonly svc: ScheduleService) {}

  private async scope(handle: string): Promise<ScheduleScope> {
    return http(await this.svc.scopeByHandle(handle));
  }

  @Get('agents/:handle/schedule')
  async schedule(@Param('handle') handle: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.schedule(await this.scope(handle), { from: from ?? null, to: to ?? null });
  }

  @Post('agents/:handle/schedule-rules')
  async addRule(@Param('handle') handle: string, @Body() body: unknown) {
    return http(await this.svc.addRule(await this.scope(handle), body, 'owner'));
  }

  @Patch('agents/:handle/schedule-rules/:id')
  async updateRule(@Param('handle') handle: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return http(await this.svc.updateRule(await this.scope(handle), id, body));
  }

  @Put('agents/:handle/series/:name')
  async putSeries(@Param('handle') handle: string, @Param('name') name: string, @Body() body: unknown) {
    return http(await this.svc.putSeries(await this.scope(handle), name, body));
  }

  @Post('agents/:handle/series/:name/unlock')
  async unlock(@Param('handle') handle: string, @Param('name') name: string) {
    return http(await this.svc.unlockSeries(await this.scope(handle), name));
  }
}
