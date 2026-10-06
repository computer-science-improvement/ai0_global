import { Body, Controller, Delete, Get, Inject, Put, Query, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { NavConfigService } from './nav-config.service';
import type { NavBadgesService } from './nav-badges.service';

export const NAV_CONFIG = 'NAV_CONFIG';
export const NAV_BADGES = 'NAV_BADGES';

/**
 * Spec 027 FR-005: the owner's dashboard menu.
 *   GET    /api/nav/config → {config|null, revision, warning?}
 *   PUT    /api/nav/config {config, baseRevision} → {revision} | 409 nav_conflict | 400 invalid_nav_config
 *   DELETE /api/nav/config → {revision:null} (back to the default menu)
 *   GET    /api/nav/badges[?fresh=1] → {generatedAt, counts} (FR-010; null per failed key, cached 10 s;
 *          fresh=1 after a dashboard change reuses only a result younger than 1 s)
 */
@Controller('api/nav')
@UseGuards(TrackingAuthGuard)
export class NavController {
  constructor(
    @Inject(NAV_CONFIG) private readonly config: NavConfigService,
    @Inject(NAV_BADGES) private readonly badges: NavBadgesService,
  ) {}

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

  @Get('badges')
  getBadges(@Query('fresh') fresh?: string) {
    return this.badges.get({ fresh: fresh === '1' });
  }
}
