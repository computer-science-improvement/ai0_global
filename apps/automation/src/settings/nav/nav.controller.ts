import { Body, Controller, Delete, Get, Inject, Put, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { NavConfigService } from './nav-config.service';

export const NAV_CONFIG = 'NAV_CONFIG';

/**
 * Spec 027 FR-005: the owner's dashboard menu.
 *   GET    /api/nav/config → {config|null, revision, warning?}
 *   PUT    /api/nav/config {config, baseRevision} → {revision} | 409 nav_conflict | 400 invalid_nav_config
 *   DELETE /api/nav/config → {revision:null} (back to the default menu)
 */
@Controller('api/nav')
@UseGuards(TrackingAuthGuard)
export class NavController {
  constructor(@Inject(NAV_CONFIG) private readonly config: NavConfigService) {}

  @Get('config')
  getConfig() {
    return this.config.get();
  }

  @Put('config')
  putConfig(@Body() body: Record<string, unknown>) {
    return this.config.put(body);
  }

  @Delete('config')
  resetConfig() {
    return this.config.reset();
  }
}
