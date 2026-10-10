import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { Agent } from '../agents/agent.types';
import { localDate } from '../roles/time';
import { shiftDate } from './schedule-rules';
import { isFail, SCHEDULE_MAX_DAYS, type ScheduleService } from './schedule.service';
import type { LiveSpec } from '../live/live-slot';

/**
 * The Overview's "Upcoming slots" (spec 023 FR-013 phase A; it replaces "Active strategies / Upcoming runs"):
 * the next series instances and owner pins of every agent, with the status of the slot that realises each one,
 * and (spec 034 FR-012) every other planned slot of the active plans — a fixed topic, or a live slot's
 * "fetch → pick the freshest → write" description (`topicMode`, `live`).
 */

/** Statuses of an ordinary slot that is still to happen (written posts wait for their time or the owner). */
const UPCOMING_STATUSES = new Set(['planned', 'running', 'awaiting_approval', 'approved']);

export interface UpcomingSlot {
  at:          string;
  kind:        'series' | 'pin' | 'slot';
  /** The series name, the pin's series / brief, or an ordinary slot's topic (a live slot: its label). */
  name:        string;
  format:      string | null;
  resourceRef: string;
  channelKey:  string;
  agent:       string;
  /** Owner-locked series, or any pin (the owner's). */
  owner:       boolean;
  origin:      string | null;
  /** The realising slot's status (planned, shadowed, awaiting_approval, …); null = not planned yet. */
  status:      string | null;
  slotId:      string | null;
  /** Spec 034 FR-010/FR-012: how the slot gets its topic; `live` carries the sources, brief, max age and the picked item. */
  topicMode?:  'fixed' | 'live';
  live?:       LiveSpec;
}

const MATCH_MS = 90 * 60_000;
const modeOf = (m: unknown): 'fixed' | 'live' => (m === 'live' ? 'live' : 'fixed');

export async function upcomingSlots(
  d: { schedule: ScheduleService; agents: { list: () => Promise<Agent[]> }; now?: () => Date },
  o: { hours?: number; limit?: number } = {},
): Promise<{ now: string; hours: number; items: UpcomingSlot[] }> {
  const now = (d.now ?? (() => new Date()))();
  const hours = Math.min(Math.max(Math.floor(o.hours ?? 24), 1), 72);
  const limit = Math.min(Math.max(Math.floor(o.limit ?? 8), 1), 50);
  const until = now.getTime() + hours * 3600_000;
  const items: UpcomingSlot[] = [];
  const orchestrators = (await d.agents.list()).filter((a) => a.kind === 'orchestrator' && !a.parentId && a.scope === 'resource' && a.scopeId?.startsWith('telegram:') && a.mode !== 'off');
  for (const a of orchestrators) {
    const sc = await d.schedule.scopeOf(a).catch(() => null);
    if (!sc || isFail(sc)) continue;
    const from = localDate(now, sc.card.timezone);
    const s = await d.schedule.schedule(sc, { from, to: shiftDate(from, Math.min(SCHEDULE_MAX_DAYS - 1, Math.ceil(hours / 24) + 1)) }).catch(() => null);
    if (!s) continue;
    const used = new Set<string>();
    // A live slot's card-feed ids read as their URLs (the dashboard shows site names).
    const feedRef = new Map((sc.card.sources ?? []).map((x) => [x.id, x.ref]));
    const view = (l: LiveSpec): LiveSpec => ({ ...l, sources: l.sources.map((id) => feedRef.get(id.replace(/^(feed|rss):/i, '')) ?? id) });
    for (const it of s.items) {
      if (it.kind !== 'series' && it.kind !== 'pin') continue;
      const at = new Date(it.at).getTime();
      if (at < now.getTime() || at > until) continue;
      const slot = it.kind === 'series'
        ? s.slots.find((x) => !used.has(x.id) && x.seriesName === it.name && x.resourceRef === it.resourceRef && Math.abs(new Date(x.at).getTime() - at) <= MATCH_MS)
        : s.slots.find((x) => !used.has(x.id) && x.scheduleRuleId === it.ruleId && x.date === it.date);
      if (slot) used.add(slot.id);
      items.push({
        at: it.at, kind: it.kind,
        name: it.kind === 'series' ? it.name : (it.seriesName ?? it.brief ?? 'Pinned post'),
        format: it.format ?? null, resourceRef: it.resourceRef, channelKey: sc.card.channelKey, agent: sc.agent.handle,
        owner: it.kind === 'pin' ? true : it.locked, origin: it.kind === 'series' ? it.origin : 'owner',
        status: slot?.status ?? null, slotId: slot?.id ?? null,
        ...(slot ? { topicMode: modeOf(slot.topicMode) } : it.kind === 'series' ? { topicMode: modeOf(it.topicMode) } : {}),
        ...(slot && 'live' in slot && slot.live ? { live: view(slot.live as LiveSpec) } : {}),
      });
    }
    // Spec 034 FR-012: the ordinary planned slots too (series / pin slots are listed above with their instance).
    for (const x of s.slots) {
      const at = new Date(x.at).getTime();
      if (used.has(x.id) || x.kind !== 'content' || at < now.getTime() || at > until || !UPCOMING_STATUSES.has(x.status)) continue;
      items.push({
        at: x.at, kind: 'slot', name: x.topic, format: x.format, resourceRef: x.resourceRef, channelKey: sc.card.channelKey, agent: sc.agent.handle,
        owner: false, origin: x.seriesName ? 'series' : 'planner', status: x.status, slotId: x.id,
        topicMode: modeOf(x.topicMode), ...('live' in x && x.live ? { live: view(x.live as LiveSpec) } : {}),
      });
    }
  }
  items.sort((x, y) => x.at.localeCompare(y.at) || x.agent.localeCompare(y.agent));
  return { now: now.toISOString(), hours, items: items.slice(0, limit) };
}

export const UPCOMING_SLOTS = 'UPCOMING_SLOTS';

export interface UpcomingSlotsPort {
  list(o: { hours?: number; limit?: number }): ReturnType<typeof upcomingSlots>;
}

@Controller('api/schedule')
@UseGuards(TrackingAuthGuard)
export class UpcomingSlotsController {
  constructor(@Inject(UPCOMING_SLOTS) private readonly port: UpcomingSlotsPort) {}

  /** `GET /api/schedule/upcoming?hours=24&limit=8` — the next series instances and pins of every agent. */
  @Get('upcoming')
  upcoming(@Query('hours') hours?: string, @Query('limit') limit?: string) {
    return this.port.list({ hours: hours ? Number(hours) || undefined : undefined, limit: limit ? Number(limit) || undefined : undefined });
  }
}
