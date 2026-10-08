import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { NetworkService } from './network.service';

export const NETWORK_SERVICE = 'NETWORK_SERVICE';

/** Playbooks, the idea pool, network plans and network mode (spec 020). */
@Controller('api')
@UseGuards(TrackingAuthGuard)
export class NetworkController {
  constructor(@Inject(NETWORK_SERVICE) private readonly svc: NetworkService) {}

  @Get('agents/:handle/network')
  network(@Param('handle') handle: string) { return this.svc.network(handle); }

  @Get('agents/:handle/playbook')
  playbook(@Param('handle') handle: string) { return this.svc.playbook(handle); }

  @Put('agents/:handle/playbook')
  putPlaybook(@Param('handle') handle: string, @Body() body: unknown) { return this.svc.putPlaybook(handle, body); }

  @Post('agents/:handle/playbook/rebuild')
  rebuild(@Param('handle') handle: string, @Body() body: unknown) { return this.svc.rebuild(handle, body); }

  @Post('playbooks/:id/approve')
  approve(@Param('id', ParseUUIDPipe) id: string) { return this.svc.decide(id, true); }

  @Post('playbooks/:id/reject')
  reject(@Param('id', ParseUUIDPipe) id: string) { return this.svc.decide(id, false); }

  @Get('agents/:handle/ideas')
  ideas(@Param('handle') handle: string, @Query('status') status?: string) { return this.svc.ideas(handle, status); }

  @Post('ideas/:id/accept')
  acceptIdea(@Param('id', ParseUUIDPipe) id: string) { return this.svc.decideIdea(id, true); }

  @Post('ideas/:id/reject')
  rejectIdea(@Param('id', ParseUUIDPipe) id: string) { return this.svc.decideIdea(id, false); }

  @Get('agents/:handle/plan')
  plan(@Param('handle') handle: string, @Query('date') date?: string) { return this.svc.plan(handle, date); }

  @Post('agents/:handle/network-mode')
  setMode(@Param('handle') handle: string, @Body() body: unknown) { return this.svc.setMode(handle, body); }

  /** Spec 024 FR-010: offers to convert legacy auto-duplicate networks and the owner's answers. */
  @Get('network-offers')
  offers() { return this.svc.offers(); }

  @Post('network-offers/:groupId/keep')
  keepOffer(@Param('groupId', ParseUUIDPipe) groupId: string) { return this.svc.keepOffer(groupId); }
}
