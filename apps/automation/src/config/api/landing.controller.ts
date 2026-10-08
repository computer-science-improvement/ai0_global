// apps/automation/src/config/api/landing.controller.ts
// PUBLIC endpoints: no `@UseGuards`. Guards in this app are applied per-controller
// (no global APP_GUARD), so omitting the guard leaves these routes unauthenticated.
// They expose only public projections — never raw rows, ids, agent handles or tokens.
import { Controller, Get, Inject } from '@nestjs/common';
import { LandingResource, LandingResourcesService } from '../landing-resources.service';
import type { LandingConfigService, LandingPublicConfig } from '../landing-config.service';

export const LANDING_CONFIG = 'LANDING_CONFIG';

@Controller('api/landing')
export class LandingController {
  constructor(
    private readonly landing: LandingResourcesService,
    @Inject(LANDING_CONFIG) private readonly config: LandingConfigService,
  ) {}

  @Get('resources')
  list(): Promise<LandingResource[]> {
    return this.landing.listPublic();
  }

  /** Spec 026 FR-002: `{defaultLang, adDm: {available, username, urls}, whiteLabelEnabled}` (cached 300 s). */
  @Get('config')
  publicConfig(): Promise<LandingPublicConfig> {
    return this.config.publicConfig();
  }
}
