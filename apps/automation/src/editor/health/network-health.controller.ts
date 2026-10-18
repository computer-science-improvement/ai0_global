import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { NetworkHealthService } from './network-health.service';
import { healthReportSection } from './network-health';

export const NETWORK_HEALTH = 'NETWORK_HEALTH';

/** Spec 049 FR-005: connections, sources, budget headroom and stuck work in one view. */
@Controller('api/network-health')
@UseGuards(TrackingAuthGuard)
export class NetworkHealthController {
  constructor(@Inject(NETWORK_HEALTH) private readonly svc: Pick<NetworkHealthService, 'health'>) {}

  @Get()
  health() { return this.svc.health(); }

  /** The text section of the weekly owner report (spec 012), for a preview. */
  @Get('report')
  async report() { return { text: healthReportSection(await this.svc.health()) }; }
}
