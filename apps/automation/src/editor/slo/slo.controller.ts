import { BadRequestException, Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { localDate } from '../roles/time';
import type { ChannelSloRepository, ChannelSloRow } from './channel-slo.repository';

export const EDITOR_SLO_REPO = 'EDITOR_SLO_REPO';
/** The 7-day strip of the dashboard. */
export const SLO_HISTORY_DAYS = 7;

export interface SloRowView {
  channelKey: string; day: string; target: number; published: number; plannedAhead: number; skipped: number;
  replacements: number; recoveryRuns: number; state: string; reason: string | null;
  lastPostAt: string | null; darkSince: string | null; updatedAt: string;
}

export const sloRowView = (r: ChannelSloRow): SloRowView => ({
  channelKey: r.channelKey, day: r.day, target: r.target, published: r.published, plannedAhead: r.plannedAhead, skipped: r.skipped,
  replacements: r.replacements, recoveryRuns: r.recoveryRuns, state: r.state, reason: r.reason,
  lastPostAt: r.lastPostAt ? r.lastPostAt.toISOString() : null, darkSince: r.darkSince ? r.darkSince.toISOString() : null, updatedAt: r.updatedAt.toISOString(),
});

/** Spec 091 FR-008: the SLO controller's day rows for /app/health → Channels. */
@Controller('api/editor/slo')
@UseGuards(TrackingAuthGuard)
export class SloApiController {
  /** Replaced in tests. */
  now: () => Date = () => new Date();

  constructor(@Inject(EDITOR_SLO_REPO) private readonly repo: Pick<ChannelSloRepository, 'forDay' | 'history'>) {}

  /** `?day=YYYY-MM-DD` (default: today in Europe/Kyiv). `rows` are that day's; `history` the last 7 days per channel, newest first. */
  @Get()
  async get(@Query('day') day?: string) {
    if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new BadRequestException({ error: 'bad_day', details: 'day must be YYYY-MM-DD' });
    const d = day ?? localDate(this.now(), 'Europe/Kyiv');
    const [rows, history] = await Promise.all([this.repo.forDay(d), this.repo.history(d, SLO_HISTORY_DAYS)]);
    return { day: d, rows: rows.map(sloRowView), history: history.map(sloRowView) };
  }
}
