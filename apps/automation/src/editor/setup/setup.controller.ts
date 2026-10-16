import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { ChannelSetupService } from './setup.service';

export const CHANNEL_SETUP_SERVICE = 'CHANNEL_SETUP_SERVICE';

/** Channel setup from history (spec 042 FR-007). Bodies are validated with zod inside ChannelSetupService. */
@Controller('api/channel-setup')
@UseGuards(TrackingAuthGuard)
export class ChannelSetupController {
  constructor(@Inject(CHANNEL_SETUP_SERVICE) private readonly svc: ChannelSetupService) {}

  @Get('overview')
  overview() { return this.svc.overview(); }

  @Post('analyze')
  analyze(@Body() body: unknown) { return this.svc.analyze(body); }

  @Get('proposals')
  list(@Query('channel') channel?: string) { return this.svc.list(channel); }

  @Get('proposals/:id')
  get(@Param('id') id: string) { return this.svc.get(id); }

  @Post('proposals/:id/apply')
  apply(@Param('id') id: string, @Body() body: unknown) { return this.svc.apply(id, body); }

  @Post('proposals/:id/discard')
  discard(@Param('id') id: string) { return this.svc.discard(id); }
}
