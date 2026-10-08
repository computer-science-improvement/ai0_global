// apps/automation/src/config/api/landing.controller.ts
// PUBLIC endpoints: no `@UseGuards`. Guards in this app are applied per-controller
// (no global APP_GUARD), so omitting the guard leaves these routes unauthenticated.
// They expose only public projections — never raw rows, ids, agent handles or tokens.
import {
  Body, Controller, Get, HttpCode, HttpException, HttpStatus, Inject, NotFoundException, Optional, Post, Req, Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { LandingResource, LandingResourcesService } from '../landing-resources.service';
import type { LandingConfigService, LandingPublicConfig } from '../landing-config.service';
import type { LandingPulse, LandingPulseService } from '../landing-pulse.service';
import type { LandingNetwork, LandingNetworksService } from '../landing-networks.service';
import { parseCtaClick, type LandingCtaService } from '../landing-cta.service';
import type { LandingClientGate } from '../landing-client-key';
import { clientIp } from '../../auth/client-info';

export const LANDING_CONFIG = 'LANDING_CONFIG';
export const LANDING_PULSE = 'LANDING_PULSE';
export const LANDING_NETWORKS = 'LANDING_NETWORKS';
export const LANDING_CTA = 'LANDING_CTA';
export const LANDING_GATE = 'LANDING_GATE';

@Controller('api/landing')
export class LandingController {
  constructor(
    private readonly landing: LandingResourcesService,
    @Inject(LANDING_CONFIG) private readonly config: LandingConfigService,
    @Inject(LANDING_PULSE) private readonly pulseSvc: LandingPulseService,
    @Optional() @Inject(LANDING_NETWORKS) private readonly networksSvc?: LandingNetworksService,
    @Optional() @Inject(LANDING_CTA) private readonly ctaSvc?: LandingCtaService,
    @Optional() @Inject(LANDING_GATE) private readonly gate?: LandingClientGate,
  ) {}

  /**
   * Spec 026 FR-009: the CTA click beacon `{cta, placement, lang}` (sent with
   * navigator.sendBeacon). Adds 1 to today's counter; stores nothing about the
   * visitor (no IP, no hash). 60/min per client (in memory, salted hash); 429 past it.
   * An unknown CTA or placement is ignored (204), so old page builds never error.
   */
  @Post('cta')
  @HttpCode(204)
  async cta(@Body() body: unknown, @Req() req: Request): Promise<void> {
    if (!this.ctaSvc) return;
    if (this.gate && !this.gate.ctaHit(clientIp(req)).ok) {
      throw new HttpException({ error: 'rate_limited' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const click = parseCtaClick(body);
    if (!click) return;
    try { await this.ctaSvc.record(click); } catch { /* a lost click is not worth a 500 on a beacon */ }
  }

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

  /** Spec 026 FR-006: the showcase grouped by network, with agent badges (cached 300 s). */
  @Get('networks')
  async networks(@Res({ passthrough: true }) res: Response): Promise<LandingNetwork[]> {
    if (!this.networksSvc) throw new NotFoundException();
    const value = await this.networksSvc.list();
    res.setHeader('Cache-Control', `public, max-age=${this.networksSvc.maxAgeSeconds}`);
    return value;
  }
}
