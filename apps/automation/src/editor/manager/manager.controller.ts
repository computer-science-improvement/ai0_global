import { Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { ManagerService } from './manager.service';

export const MANAGER_SERVICE = 'MANAGER_SERVICE';

/** Directives, manager reviews and the KPI digest (spec 021). */
@Controller('api')
@UseGuards(TrackingAuthGuard)
export class ManagerController {
  constructor(@Inject(MANAGER_SERVICE) private readonly svc: ManagerService) {}

  @Get('directives')
  directives(
    @Query('status') status?: string, @Query('agent') agent?: string, @Query('binding') binding?: string,
    @Query('kind') kind?: string, @Query('verified') verified?: string,
  ) { return this.svc.directives({ status, agent, binding, kind, verified }); }

  @Post('directives/:id/approve')
  approve(@Param('id', ParseUUIDPipe) id: string) { return this.svc.decide(id, true); }

  @Post('directives/:id/decline')
  decline(@Param('id', ParseUUIDPipe) id: string) { return this.svc.decide(id, false); }

  @Get('manager/reviews')
  reviews(@Query('limit') limit?: string) { return this.svc.reviews(limit); }

  @Post('manager/run')
  run() { return this.svc.runNow(); }

  @Get('kpi/digest')
  digest() { return this.svc.digest(); }
}
