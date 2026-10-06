import { Body, Controller, Get, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { AutonomyService } from './autonomy';

export const AUTONOMY_SERVICE = 'AUTONOMY_SERVICE';

/**
 * The owner's approve ⇄ live switch (spec 031 FR-010): the confirm dialog's
 * numbers and the switch itself. Owner-only (TrackingAuthGuard); no agent tool
 * calls these routes.
 */
@Controller('api/editor/approvals')
@UseGuards(TrackingAuthGuard)
export class AutonomyController {
  constructor(@Inject(AUTONOMY_SERVICE) private readonly svc: AutonomyService) {}

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
