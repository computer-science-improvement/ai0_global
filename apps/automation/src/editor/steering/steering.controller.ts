import { Body, Controller, Get, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { SteeringService } from './steering.service';

export const STEERING_SERVICE = 'STEERING_SERVICE';

/** Steering (spec 045 FR-007). Bodies are validated with zod inside SteeringService. */
@Controller('api/steering')
@UseGuards(TrackingAuthGuard)
export class SteeringController {
  constructor(@Inject(STEERING_SERVICE) private readonly svc: SteeringService) {}

  @Get()
  list(@Query('target') target?: string) { return this.svc.list(target); }

  @Get('estimate')
  estimate() { return this.svc.estimate(); }

  @Get('active')
  active(@Query('target') target: string) { return this.svc.activeSummary(String(target ?? '')); }

  @Get(':id')
  get(@Param('id') id: string) { return this.svc.get(id); }

  @Post()
  create(@Body() body: unknown) { return this.svc.create(body); }

  @Post(':id/activate')
  activate(@Param('id') id: string) { return this.svc.activate(id); }

  @Post(':id/pause')
  pause(@Param('id') id: string) { return this.svc.pause(id); }

  @Post(':id/resume')
  resume(@Param('id') id: string) { return this.svc.resume(id); }

  @Post(':id/discard')
  discard(@Param('id') id: string) { return this.svc.discard(id); }

  @Post(':id/reanalyze')
  reanalyze(@Param('id') id: string) { return this.svc.reanalyze(id); }

  @Patch(':id/rules/:ruleId')
  patchRule(@Param('id') id: string, @Param('ruleId') ruleId: string, @Body() body: unknown) { return this.svc.patchRule(id, ruleId, body); }
}
