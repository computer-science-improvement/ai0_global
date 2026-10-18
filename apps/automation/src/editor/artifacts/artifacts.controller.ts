import { Body, Controller, Get, Inject, Param, ParseIntPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { ArtifactsService } from './artifacts.service';

export const ARTIFACTS_SERVICE = 'ARTIFACTS_SERVICE';

/** Spec 048 FR-001: every artifact that shapes an agent, in one list; versions; the owner's hand edit. */
@Controller('api/artifacts')
@UseGuards(TrackingAuthGuard)
export class ArtifactsController {
  constructor(@Inject(ARTIFACTS_SERVICE) private readonly svc: ArtifactsService) {}

  @Get()
  list(@Query() q: Record<string, unknown>) { return this.svc.list(q); }

  @Get(':type/:id')
  get(@Param('type') type: string, @Param('id') id: string) { return this.svc.get(type, id); }

  @Get(':type/:id/versions/:v')
  version(@Param('type') type: string, @Param('id') id: string, @Param('v', ParseIntPipe) v: number) { return this.svc.version(type, id, v); }

  @Patch(':type/:id')
  patch(@Param('type') type: string, @Param('id') id: string, @Body() body: unknown) { return this.svc.patch(type, id, body); }
}
