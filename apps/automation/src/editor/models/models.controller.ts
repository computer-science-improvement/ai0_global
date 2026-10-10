import { Body, Controller, Get, Inject, Post, Put, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { ModelsService } from './models.service';

export const MODELS_SERVICE = 'MODELS_SERVICE';

/**
 * The Models page API (spec 035), owner-only like the rest of the admin API.
 * An agent's own model / reasoning effort is set through PATCH /api/agents/:handle
 * (validated against this catalog). Bodies are validated with zod in ModelsService.
 */
@Controller('api/models')
@UseGuards(TrackingAuthGuard)
export class ModelsController {
  constructor(@Inject(MODELS_SERVICE) private readonly svc: ModelsService) {}

  @Get()
  catalog() {
    return this.svc.catalog();
  }

  @Get('overview')
  overview() {
    return this.svc.overview();
  }

  @Put('default')
  setDefault(@Body() body: unknown) {
    return this.svc.setDefault(body);
  }

  @Put('critic')
  setCritic(@Body() body: unknown) {
    return this.svc.setCritic(body);
  }

  @Post('bulk')
  bulk(@Body() body: unknown) {
    return this.svc.bulk(body);
  }

  @Post('channels/clear')
  clearChannel(@Body() body: unknown) {
    return this.svc.clearChannel(body);
  }
}
