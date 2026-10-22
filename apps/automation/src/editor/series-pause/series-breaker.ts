import type { OwnerInbox } from '../agents/owner-inbox';
import { classifyClose, PAUSING_CAUSES, skipsUk } from './skip-cause';
import { skipLine, type RecentSkip, type SeriesPause, type SeriesPausesRepository } from './series-pauses.repository';
import { pauseMapKey, seriesIdOf, skipStreaks, type StreakHit, type StreakSlot } from './streak';

/** Spec 060 FR-001: SERIES_SKIP_STREAK (default 3, 0 = off). */
export const DEFAULT_SERIES_SKIP_STREAK = 3;
export const BREAKER_EVERY_MS = 2 * 60_000;
/** How many recent skip lines per series the planner reads (FR-002). */
export const PLANNER_SKIPS_PER_SERIES = 3;

export const SERIES_PAUSED_KIND = 'series_paused';
export const SERIES_PAUSE_REF = 'series_pause';

const CAUSE_UK = { no_material: 'немає матеріалу', source_unreachable: 'джерело недоступне', owner: 'пауза власника' } as const;
const CAUSE_EN = { no_material: 'no material to write from', source_unreachable: 'the source cannot be read', owner: 'paused by the owner' } as const;

/** Ukrainian name of what was paused, for the owner's Telegram wording. */
function whatUk(p: Pick<SeriesPause, 'key' | 'label'>, channelKey: string): string {
  if (p.key.startsWith('series:')) return `серію "${p.label}" на ${channelKey}`;
  if (p.key.startsWith('rule:')) return `закріплений слот ${p.label.replace(/^fixed slot /, '')} на ${channelKey}`;
  return `планування ${p.label}`;
}

/** The Inbox note of a new pause: stored in English (dashboard), the Telegram alert in Ukrainian (spec 060 FR-001). */
export function pausedNote(p: SeriesPause): { title: string; body: string; alert: { title: string; body: string } } {
  const reason = p.reason;
  const what = p.key.startsWith('series:') ? `Series "${p.label}" on ${p.channelKey}` : p.key.startsWith('rule:') ? `Fixed slot ${p.label.replace(/^fixed slot /, '')} on ${p.channelKey}` : `Planning of ${p.label}`;
  return {
    title: `${what} paused: ${p.streak} skips in a row`,
    body: [
      `${what} was skipped ${p.streak} times in a row (${CAUSE_EN[p.cause]}), so the planner stops planning it and its planned slots are skipped at no cost.`,
      reason ? `Last reason: ${reason}` : '',
      'Resume it on the agent page (Overview → Paused series), or from the Telegram card.',
    ].filter(Boolean).join('\n'),
    alert: {
      title: `Призупинено ${whatUk(p, p.channelKey)}: ${p.streak} ${skipsUk(p.streak)} поспіль`,
      body: [
        reason ? `Остання причина: ${reason}` : `Причина: ${CAUSE_UK[p.cause]}.`,
        'Планувальник більше її не планує, заплановані слоти пропускаються без витрат.',
      ].join('\n'),
    },
  };
}

export interface SeriesBreakerDeps {
  repo:     Pick<SeriesPausesRepository, 'closedSlots' | 'lastResumes' | 'insertOpen' | 'open' | 'skipPlanned' | 'agentOf'>;
  inbox:    Pick<OwnerInbox, 'post'>;
  /** SERIES_SKIP_STREAK, read at each check (a live setting); 0 = off. */
  threshold: () => number;
  everyMs?: number;
  log?:     (m: string) => void;
}

/**
 * Spec 060 FR-001: the dead-series breaker. From the scheduler's tick (code only, no LLM): counts the consecutive
 * same-cause skips of every series over the closed slots, pauses a series that reached SERIES_SKIP_STREAK (one open
 * pause per series, one Inbox note), and skips the planned slots of every paused series with `series_paused` ($0).
 * A critic streak is not paused: it keeps the critic_reject_streak note.
 */
export class SeriesBreaker {
  private lastRun = 0;

  constructor(private readonly d: SeriesBreakerDeps) {}

  /** Returns the number of new pauses. Throttled; `force` skips the throttle (tests, the card action). */
  async check(now: Date, force = false): Promise<number> {
    const every = this.d.everyMs ?? BREAKER_EVERY_MS;
    if (!force && every > 0 && now.getTime() - this.lastRun < every) return 0;
    this.lastRun = now.getTime();
    let created = 0;
    const threshold = this.d.threshold();
    if (threshold > 0) {
      const [slots, resumedAt, open] = await Promise.all([this.d.repo.closedSlots(now), this.d.repo.lastResumes(), this.d.repo.open()]);
      const openKeys = new Set(open.map((p) => pauseMapKey(p.channelKey, p.key)));
      const hits = skipStreaks(slots, { threshold, resumedAt })
        .filter((h) => (PAUSING_CAUSES as readonly string[]).includes(h.cause) && !openKeys.has(pauseMapKey(h.channelKey, h.key)));
      for (const h of hits) {
        try { if (await this.pause(h)) created++; } catch (err: any) { this.d.log?.(`series pause of ${h.channelKey} ${h.key} failed: ${err?.message ?? err}`); }
      }
    }
    // Planned slots of every open pause (including a pause the owner made, and slots added after the pause).
    for (const p of await this.d.repo.open()) {
      try {
        const n = await this.d.repo.skipPlanned(p);
        if (n) this.d.log?.(`series "${p.label}" on ${p.channelKey} is paused: ${n} planned slot(s) skipped`);
      } catch (err: any) { this.d.log?.(`skipping planned slots of ${p.channelKey} ${p.key} failed: ${err?.message ?? err}`); }
    }
    return created;
  }

  private async pause(h: StreakHit): Promise<SeriesPause | null> {
    const p = await this.d.repo.insertOpen({ channelKey: h.channelKey, key: h.key, label: h.label, cause: h.cause as SeriesPause['cause'], reason: h.reason, streak: h.n });
    if (!p) return null;
    const note = pausedNote(p);
    try {
      await this.d.inbox.post({
        agentId: await this.d.repo.agentOf(p.channelKey).catch(() => null), kind: SERIES_PAUSED_KIND, severity: 'action',
        title: note.title, body: note.body, refType: SERIES_PAUSE_REF, refId: p.id, alert: note.alert,
      });
    } catch (err: any) { this.d.log?.(`series pause note for ${p.channelKey} failed: ${err?.message ?? err}`); }
    return p;
  }
}

/**
 * Spec 060 FR-002: the last `PLANNER_SKIPS_PER_SERIES` skip reasons of every series of one channel whose latest
 * counted slot was a skip (a series that posted since is not listed) — what the planner reads before it plans.
 */
export function recentSkips(slots: StreakSlot[], perSeries = PLANNER_SKIPS_PER_SERIES): RecentSkip[] {
  const groups = new Map<string, StreakSlot[]>();
  for (const s of slots) {
    const k = seriesIdOf(s).key;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const out: RecentSkip[] = [];
  for (const [key, g] of groups) {
    const ordered = g.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
    const counted = ordered.filter((s) => classifyClose(s).k !== 'ignore');
    const last = counted[counted.length - 1];
    if (!last || classifyClose(last).k === 'out') continue;
    const skips = counted.filter((s) => s.status === 'skipped' || s.status === 'failed').slice(-perSeries);
    const label = seriesIdOf(skips[0] ?? last).label;
    for (const s of skips) out.push({ key, label, line: skipLine(s.error), at: s.scheduledAt });
  }
  return out;
}
