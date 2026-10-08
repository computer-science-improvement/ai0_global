import { BadRequestException, ConflictException, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { parseResourceRef } from '../agents/agent.types';
import { isActivePause, type ResourcePause, type ResourcePauseService } from './resource-pauses';

export const RESOURCE_PAUSES = 'RESOURCE_PAUSES';

const view = (p: ResourcePause, now: Date) => ({
  id: p.id, resourceRef: p.resourceRef, agentId: p.agentId, agentHandle: p.agentHandle ?? null, directiveId: p.directiveId,
  reason: p.reason, startsAt: p.startsAt, until: p.until, liftedAt: p.liftedAt, liftedBy: p.liftedBy, createdAt: p.createdAt,
  active: isActivePause(p, now),
});

/** Resource pauses made by pause_resource directives (spec 025 FR-013, FR-018). */
export class ResourcePausesApi {
  constructor(private readonly pauses: Pick<ResourcePauseService, 'list' | 'lift'>, private readonly now: () => Date = () => new Date()) {}

  async list(q: { active?: string; limit?: string }) {
    const active = q.active === 'true' ? true : q.active === 'false' ? false : undefined;
    if (q.active !== undefined && active === undefined) throw new BadRequestException({ error: 'invalid_filter', details: 'active must be true or false' });
    const limit = q.limit === undefined ? undefined : Number(q.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new BadRequestException({ error: 'invalid_filter', details: 'limit must be a positive integer' });
    const now = this.now();
    return { pauses: (await this.pauses.list({ active, limit })).map((p) => view(p, now)) };
  }

  /** The owner lifts a pause early; 409 `not_paused` when the resource has no active pause. */
  async lift(ref: string) {
    if (!parseResourceRef(ref)) throw new BadRequestException({ error: 'invalid_ref', details: 'expected <platform>:<id>, e.g. telegram:@channel' });
    const p = await this.pauses.lift(ref, 'owner');
    if (!p) throw new ConflictException({ error: 'not_paused', details: `${ref} has no active pause` });
    return { pause: view(p, this.now()) };
  }
}

@Controller('api/resources')
@UseGuards(TrackingAuthGuard)
export class ResourcePausesController {
  constructor(@Inject(RESOURCE_PAUSES) private readonly api: ResourcePausesApi) {}

  @Get('pauses')
  list(@Query('active') active?: string, @Query('limit') limit?: string) { return this.api.list({ active, limit }); }

  @Post(':ref/pause/lift')
  lift(@Param('ref') ref: string) { return this.api.lift(ref); }
}
