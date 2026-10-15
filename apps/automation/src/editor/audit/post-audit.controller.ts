import { BadRequestException, Controller, Get, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { parseResourceRef } from '../agents/agent.types';
import { AUDIT_DAYS, KEEP_DAYS } from './post-audit';
import type { PostAuditService } from './post-audit.service';

export const POST_AUDIT = 'POST_AUDIT';

/**
 * Spec 037 FR-014 (T14): the post audit for the dashboard.
 *   GET  /api/editor/audit?resource=<ref>&days=7  → one resource's findings grouped by code (Network health notes);
 *   POST /api/editor/audit/run[?resource=<ref>]    → audit now (one resource, or every resource with posts in 7 days).
 */
export class PostAuditApi {
  constructor(private readonly audit: Pick<PostAuditService, 'view' | 'run' | 'activeRefs'>, private readonly now: () => Date = () => new Date()) {}

  private ref(resource: string | undefined): string {
    const ref = (resource ?? '').trim();
    if (!ref || ref.length > 200 || !parseResourceRef(ref)) {
      throw new BadRequestException({ error: 'invalid_ref', details: 'resource must be <platform>:<id>, e.g. telegram:@channel' });
    }
    return ref;
  }

  async view(q: { resource?: string; days?: string }) {
    const days = q.days === undefined ? AUDIT_DAYS : Number(q.days);
    if (!Number.isInteger(days) || days < 1 || days > KEEP_DAYS) {
      throw new BadRequestException({ error: 'invalid_days', details: `days must be an integer from 1 to ${KEEP_DAYS}` });
    }
    return this.audit.view(this.ref(q.resource), this.now(), days);
  }

  async run(q: { resource?: string }) {
    const refs = q.resource === undefined ? undefined : [this.ref(q.resource)];
    const results = await this.audit.run(this.now(), refs);
    return { results };
  }
}

@Controller('api/editor/audit')
@UseGuards(TrackingAuthGuard)
export class PostAuditController {
  constructor(@Inject(POST_AUDIT) private readonly api: PostAuditApi) {}

  @Get()
  view(@Query('resource') resource?: string, @Query('days') days?: string) { return this.api.view({ resource, days }); }

  @Post('run')
  run(@Query('resource') resource?: string) { return this.api.run({ resource }); }
}
