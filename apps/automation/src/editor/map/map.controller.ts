import { Body, Controller, Get, Inject, Post, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { MapActions } from './map.actions';
import type { MapService } from './map.service';

export const MAP_SERVICE = 'MAP_SERVICE';
export const MAP_ACTIONS = 'MAP_ACTIONS';

/** Spec 056 FR-001: the network map snapshot (agents, resources, roads, alerts and events in one document), and the
 *  changes the owner makes from the map (a resource's network, a blocked promo pair). */
@Controller('api/map')
@UseGuards(TrackingAuthGuard)
export class MapController {
  constructor(
    @Inject(MAP_SERVICE) private readonly svc: Pick<MapService, 'snapshot'>,
    @Inject(MAP_ACTIONS) private readonly actions: Pick<MapActions, 'setGroup' | 'setPairBlocked'>,
  ) {}

  @Get()
  snapshot() { return this.svc.snapshot(); }

  /** { ref, groupId | null } — move a resource into a network or out of any. */
  @Post('resource-network')
  setGroup(@Body() body: unknown) { return this.actions.setGroup(body); }

  /** { a, b, blocked } — block or allow promos between two resources (both ways). */
  @Post('promo-block')
  setPairBlocked(@Body() body: unknown) { return this.actions.setPairBlocked(body); }
}
