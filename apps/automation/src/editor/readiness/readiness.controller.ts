import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { ChannelNotFound } from './facts';
import type { ReadinessService } from './readiness.service';

export const READINESS_SERVICE = 'READINESS_SERVICE';

/** A13: no field = Fix all; `codes` = the open findings with those codes; `keys` = those findings only. */
export const FixBody = z.object({
  codes: z.array(z.string().min(1).max(100)).max(100).optional(),
  keys:  z.array(z.string().min(1).max(200)).max(200).optional(),
}).strict();

const truthy = (v: string | undefined): boolean => v === '1' || v === 'true';

/** The channel doctor's stored result (spec 072 FR-007). No card = 404 `channel_not_found`. */
@Controller('api/editor/channels')
@UseGuards(TrackingAuthGuard)
export class ReadinessController {
  constructor(@Inject(READINESS_SERVICE) private readonly svc: ReadinessService) {}

  /** The stored row while it is under 60 seconds old; `?fresh=1` skips the window. Neither fixes anything or sends a card. */
  @Get(':key/readiness')
  get(@Param('key') key: string, @Query('fresh') fresh?: string) {
    return this.guard(() => this.svc.current(key, { fresh: truthy(fresh) }));
  }

  @Post(':key/readiness/recheck')
  recheck(@Param('key') key: string) {
    return this.guard(() => this.svc.recheck(key, 'owner'));
  }

  @Post(':key/readiness/fix')
  fix(@Param('key') key: string, @Body() body: unknown) {
    const b = FixBody.safeParse(body ?? {});
    if (!b.success) throw new BadRequestException({ error: 'invalid_body', details: b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    return this.guard(() => this.svc.fix(key, b.data, 'dashboard'));
  }

  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (err) {
      if (err instanceof ChannelNotFound) throw new NotFoundException({ error: 'channel_not_found', details: err.message });
      throw err;
    }
  }
}
