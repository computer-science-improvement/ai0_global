import { Body, ConflictException, Controller, Get, HttpException, Inject, NotFoundException, Param, Post, Query, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { reportCounts, type AuditReport } from './audit-report';
import type { AuditService, FindingOutcome, RunOutcome } from './audit.service';

export const AUDIT_SERVICE = 'AUDIT_SERVICE';

/** A report as the API and the dashboard see it. */
export function reportJson(r: AuditReport) {
  return { ...r, counts: reportCounts(r.findings) };
}

/** The sysadmin's audit (spec 055). */
@Controller('api/audits')
@UseGuards(TrackingAuthGuard)
export class AuditController {
  constructor(@Inject(AUDIT_SERVICE) private readonly svc: AuditService) {}

  @Get()
  async list(@Query('limit') limit?: string) {
    return { reports: await this.svc.list(limit ? Number(limit) : undefined) };
  }

  @Post('run')
  async run() {
    return this.runResult(await this.svc.runInBackground('owner'));
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const r = await this.svc.get(id);
    if (!r) throw new NotFoundException({ error: 'report_not_found' });
    return reportJson(r);
  }

  @Post(':id/findings/:key/apply')
  async apply(@Param('id') id: string, @Param('key') key: string) {
    return this.findingResult(await this.svc.apply(id, key));
  }

  @Post(':id/findings/:key/dismiss')
  async dismiss(@Param('id') id: string, @Param('key') key: string, @Body() body: { days?: unknown } | undefined) {
    const days = typeof body?.days === 'number' ? body.days : undefined;
    return this.findingResult(await this.svc.dismiss(id, key, days));
  }

  private runResult(o: RunOutcome) {
    if (o.ok) return reportJson(o.report);
    if (o.error === 'already_running') throw new ConflictException({ error: 'already_running', details: 'an audit is already running' });
    throw new HttpException({ error: o.error, details: o.details }, o.error === 'week_taken' ? 409 : 500);
  }

  private findingResult(o: FindingOutcome) {
    if (o.ok) return { ...reportJson(o.report), result: o.result ?? null };
    if (o.error === 'report_not_found' || o.error === 'finding_not_found') throw new NotFoundException({ error: o.error });
    if (o.error === 'fix_failed') throw new UnprocessableEntityException({ error: o.error, details: o.details, report: o.report ? reportJson(o.report) : undefined });
    throw new ConflictException({ error: o.error, details: o.details });
  }
}
