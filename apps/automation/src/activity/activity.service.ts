import { Injectable } from '@nestjs/common';
import { ActivityRepository, ActivityType } from './activity.repository';

export interface ActivityEvent {
  id:         string;
  at:         string;
  source:     'strategy_run' | 'scheduled_post';
  type:       ActivityType;
  status:     string;
  channelId:  string | null;
  channel:    string | null;
  strategyId: string | null;
  strategy:   string | null;
  detail:     string | null;
  durationMs: number | null;
}

export interface ActivityListResult {
  items:   ActivityEvent[];
  hasMore: boolean;
}

/** UI platform tab → the concrete binding platforms it covers. */
const PLATFORM_SETS: Record<string, string[]> = {
  telegram: ['telegram'],
  meta:     ['instagram', 'facebook', 'threads'],
  tiktok:   ['tiktok'],
};

@Injectable()
export class ActivityService {
  constructor(private readonly repo: ActivityRepository) {}

  async list(opts: {
    platform: string;
    type?:    ActivityType | null;
    limit:    number;
    offset:   number;
  }): Promise<ActivityListResult> {
    const platforms = PLATFORM_SETS[opts.platform] ?? ['telegram'];
    const rows = await this.repo.list({ platforms, type: opts.type ?? null, limit: opts.limit, offset: opts.offset });
    const hasMore = rows.length > opts.limit;
    const items = rows.slice(0, opts.limit).map((r): ActivityEvent => ({
      id:         `${r.source}:${r.row_id}`,
      at:         r.at instanceof Date ? r.at.toISOString() : String(r.at),
      source:     r.source,
      type:       r.type,
      status:     r.status,
      channelId:  r.channel_id,
      channel:    r.channel,
      strategyId: r.strategy_id,
      strategy:   r.strategy,
      detail:     r.detail,
      durationMs: r.duration_ms != null ? Math.round(r.duration_ms) : null,
    }));
    return { items, hasMore };
  }
}
