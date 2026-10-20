import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { LaunchService } from './launch.service';

export const LAUNCH_SERVICE = 'LAUNCH_SERVICE';

/** Channel launch (spec 052). Bodies are validated with zod inside LaunchService. */
@Controller('api/launches')
@UseGuards(TrackingAuthGuard)
export class LaunchController {
  constructor(@Inject(LAUNCH_SERVICE) private readonly svc: LaunchService) {}

  @Get()
  list(@Query('channel') channel?: string) { return this.svc.list(channel); }

  @Post()
  create(@Body() body: unknown) { return this.svc.create(body); }

  @Get(':id')
  get(@Param('id') id: string) { return this.svc.viewById(id); }

  @Post(':id/start')
  start(@Param('id') id: string) { return this.svc.start(id); }

  @Post(':id/check')
  check(@Param('id') id: string) { return this.svc.check(id); }

  @Post(':id/go-live')
  goLive(@Param('id') id: string) { return this.svc.goLive(id); }

  @Post(':id/not-yet')
  notYet(@Param('id') id: string) { return this.svc.notYet(id); }

  @Post(':id/redo')
  redo(@Param('id') id: string, @Body() body: unknown) { return this.svc.redo(id, body); }

  @Post(':id/discard')
  discard(@Param('id') id: string) { return this.svc.discard(id); }
}
