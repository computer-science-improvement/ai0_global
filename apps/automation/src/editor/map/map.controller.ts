import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { MapService } from './map.service';

export const MAP_SERVICE = 'MAP_SERVICE';

/** Spec 056 FR-001: the network map snapshot (agents, resources, roads, alerts and events in one document). */
@Controller('api/map')
@UseGuards(TrackingAuthGuard)
export class MapController {
  constructor(@Inject(MAP_SERVICE) private readonly svc: Pick<MapService, 'snapshot'>) {}

  @Get()
  snapshot() { return this.svc.snapshot(); }
}
