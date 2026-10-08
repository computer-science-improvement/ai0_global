// apps/automation/src/config/api/landing.controller.ts
// PUBLIC endpoints: no `@UseGuards`. Guards in this app are applied per-controller
// (no global APP_GUARD), so omitting the guard leaves these routes unauthenticated.
// They expose only public projections — never raw rows, ids, agent handles or tokens.
import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { LandingResource, LandingResourcesService } from '../landing-resources.service';
import type { LandingConfigService, LandingPublicConfig } from '../landing-config.service';
import type { LandingPulse, LandingPulseService } from '../landing-pulse.service';

export const LANDING_CONFIG = 'LANDING_CONFIG';
export const LANDING_PULSE = 'LANDING_PULSE';

@Controller('api/landing')
export class LandingController {
  constructor(
    private readonly landing: LandingResourcesService,
    @Inject(LANDING_CONFIG) private readonly config: LandingConfigService,
    @Inject(LANDING_PULSE) private readonly pulseSvc: LandingPulseService,
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

  /** Spec 026 FR-004: aggregate proof that agents run the network (cached 300 s; 503 when unavailable). */
  @Get('pulse')
  async pulse(@Res({ passthrough: true }) res: Response): Promise<LandingPulse> {
    res.setHeader('Cache-Control', 'no-store'); // replaced on success: a 503 is never cached
    const value = await this.pulseSvc.get();
    res.setHeader('Cache-Control', `public, max-age=${this.pulseSvc.maxAgeSeconds}`);
    return value;
  }
}
