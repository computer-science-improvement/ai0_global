import { Body, Controller, Get, Inject, Param, Post, Put, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { LoadoutAdminService } from './loadout.admin.service';

export const LOADOUT_SERVICE = 'LOADOUT_SERVICE';

/** An agent's loadout (spec 054 FR-004). Bodies are validated with zod inside LoadoutAdminService. */
@Controller('api/agents')
@UseGuards(TrackingAuthGuard)
export class LoadoutController {
  constructor(@Inject(LOADOUT_SERVICE) private readonly svc: LoadoutAdminService) {}

  @Get(':handle/loadout')
  get(@Param('handle') handle: string) { return this.svc.view(handle); }

  @Put(':handle/loadout/tools')
  putTools(@Param('handle') handle: string, @Body() body: unknown) { return this.svc.putTools(handle, body); }

  @Post(':handle/loadout/apply')
  apply(@Param('handle') handle: string, @Body() body: unknown) { return this.svc.apply(handle, body); }

  @Post(':handle/loadout/reset')
  reset(@Param('handle') handle: string) { return this.svc.reset(handle); }
}
