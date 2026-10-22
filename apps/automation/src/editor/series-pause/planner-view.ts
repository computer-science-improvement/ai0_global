import type { PausedSeriesCtx } from '../schedule/plan-schedule-rules';
import { recentSkips } from './series-breaker';
import { resourceOfKey, seriesNameOfKey, type SeriesPausesRepository } from './series-pauses.repository';

/**
 * Spec 060 FR-001 + FR-002: what the planners see of the dead-series breaker for one channel — the paused series
 * (not planned, not required; a slot of one is a plan error) and the last skip reasons per series (≤ 3 lines, each
 * ≤ 160 characters) of the series whose latest slot was a skip and that are not paused already.
 */
export class PlannerPauseView {
  constructor(private readonly repo: Pick<SeriesPausesRepository, 'open' | 'closedSlots'>) {}

  async forChannel(channelKey: string, now: Date): Promise<{ paused: PausedSeriesCtx[]; recentSkips: Array<{ label: string; lines: string[] }> }> {
    const open = await this.repo.open(channelKey);
    // A pinned slot (rule:) is the owner's: the planner never plans it, so only series and resources are told.
    const paused: PausedSeriesCtx[] = open.filter((p) => !p.key.startsWith('rule:')).map((p) => ({
      name: seriesNameOfKey(p.key), resourceRef: resourceOfKey(p.key), label: p.label, streak: p.streak, reason: p.reason,
    }));
    const pausedKeys = new Set(open.map((p) => p.key));
    const slots = (await this.repo.closedSlots(now, channelKey)).filter((s) => !s.scheduleRuleId || s.seriesName);
    const grouped = new Map<string, { label: string; lines: string[] }>();
    for (const r of recentSkips(slots)) {
      if (pausedKeys.has(r.key)) continue;
      const g = grouped.get(r.key) ?? { label: r.label, lines: [] };
      g.lines.push(r.line);
      grouped.set(r.key, g);
    }
    return { paused, recentSkips: [...grouped.values()] };
  }
}
