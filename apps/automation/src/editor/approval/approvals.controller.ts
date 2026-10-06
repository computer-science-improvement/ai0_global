import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { ApprovalsService } from './approvals.service';

export const APPROVALS_SERVICE = 'APPROVALS_SERVICE';

/**
 * The owner's approval surface (spec 031 FR-011). Bodies are plain JSON
 * validated with zod inside ApprovalsService; a decision that lost the race
 * to another tab answers 409 `already_decided`.
 */
@Controller('api/editor/approvals')
@UseGuards(TrackingAuthGuard)
export class ApprovalsController {
  constructor(@Inject(APPROVALS_SERVICE) private readonly svc: ApprovalsService) {}

  @Get()
  list(@Query() q: Record<string, unknown>) {
    return this.svc.list(q);
  }

  @Get('count')
  count() {
    return this.svc.count();
  }

  @Post('bulk')
  bulk(@Body() body: unknown) {
    return this.svc.bulk(body);
  }

  @Post(':slotId/approve')
  approve(@Param('slotId', ParseUUIDPipe) id: string) {
    return this.svc.approve(id);
  }

  @Post(':slotId/edit')
  edit(@Param('slotId', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.edit(id, body);
  }

  @Post(':slotId/reschedule')
  reschedule(@Param('slotId', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.reschedule(id, body);
  }

  @Post(':slotId/reject')
  reject(@Param('slotId', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.reject(id, body);
  }
}
