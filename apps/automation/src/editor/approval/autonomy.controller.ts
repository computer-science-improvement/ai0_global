import { Body, Controller, Get, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { AutonomyService } from './autonomy';

export const AUTONOMY_SERVICE = 'AUTONOMY_SERVICE';

/**
 * Approval stats (spec 031 FR-011) and the owner's approve ⇄ live switch
 * (FR-010): the confirm dialog's numbers and the switch itself. Owner-only
 * (TrackingAuthGuard); no agent tool calls these routes.
 */
@Controller('api/editor/approvals')
@UseGuards(TrackingAuthGuard)
export class AutonomyController {
  constructor(@Inject(AUTONOMY_SERVICE) private readonly svc: AutonomyService) {}

  /**
   * FR-011: ?resource=@chan|telegram:@chan|instagram:123 &channel=@chan &days=14 (1–90).
   * Totals and one block per resource; no filter = every resource (029 Agents card).
   */
  @Get('stats')
  stats(@Query() q: Record<string, unknown>) {
    return this.svc.stats(q);
  }

  /** ?channel=@chan (the network) or ?resource=telegram:@chan */
  @Get('autonomy')
  preview(@Query() q: Record<string, unknown>) {
    return this.svc.preview(q);
  }

  /** { channel | resource, mode: 'live' | 'approve', approve_waiting?: boolean (default true) } */
  @Post('autonomy')
  switchMode(@Body() body: unknown) {
    return this.svc.switchMode(body);
  }
}
