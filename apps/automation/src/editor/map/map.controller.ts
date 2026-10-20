import { Body, Controller, Get, Inject, Post, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { MapActions } from './map.actions';
import type { MapService } from './map.service';

export const MAP_SERVICE = 'MAP_SERVICE';
export const MAP_ACTIONS = 'MAP_ACTIONS';

/** Spec 056 FR-001: the network map snapshot (agents, resources, roads, alerts and events in one document), and the
 *  changes the owner makes from the map (a resource's network, a network's members, promo links). */
@Controller('api/map')
@UseGuards(TrackingAuthGuard)
export class MapController {
  constructor(
    @Inject(MAP_SERVICE) private readonly svc: Pick<MapService, 'snapshot'>,
    @Inject(MAP_ACTIONS) private readonly actions: Pick<MapActions, 'setGroup' | 'setPairBlocked' | 'setLinks' | 'setMembers'>,
  ) {}

  @Get()
  snapshot() { return this.svc.snapshot(); }

  /** { ref, groupId | null } — move a resource into a network or out of any. */
  @Post('resource-network')
  setGroup(@Body() body: unknown) { return this.actions.setGroup(body); }

  /** { a, b, blocked } — block or allow promos between two resources (both ways). Kept for the first map (spec 056). */
  @Post('promo-block')
  setPairBlocked(@Body() body: unknown) { return this.actions.setPairBlocked(body); }

  /** { ref, add[], remove[] } — link a resource with others / break its links (spec 058, at most 30 resources). */
  @Post('links')
  setLinks(@Body() body: unknown) { return this.actions.setLinks(body); }

  /** { groupId, add[], remove[] } — put several resources in a network and take several out (spec 058). */
  @Post('network-members')
  setMembers(@Body() body: unknown) { return this.actions.setMembers(body); }
}
