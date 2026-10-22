import { classifyClose, reasonLine, type SkipCause } from './skip-cause';

/**
 * Spec 060 FR-001: the streak counter. The consecutive closed slots of one series with the same cause class, counted
 * from the newest backwards. Same series = same `series_name`, else the same `schedule_rule_id`, else the resource
 * (the channel itself for a plain slot).
 */
export interface StreakSlot {
  id:             string;
  channelKey:     string;
  resourceRef:    string | null;
  seriesName:     string | null;
  scheduleRuleId: string | null;
  topic:          string;
  scheduledAt:    Date;
  updatedAt:      Date;
  status:         string;
  error:          string | null;
  criticVerdict:  string | null;
}

export type SeriesKind = 'series' | 'rule' | 'resource';

export interface SeriesId { channelKey: string; key: string; kind: SeriesKind; label: string; resourceRef: string }

export const refOfSlot = (s: Pick<StreakSlot, 'resourceRef' | 'channelKey'>) => s.resourceRef ?? `telegram:${s.channelKey}`;

/** The series a slot belongs to, as the pause table keys it. */
export function seriesIdOf(s: StreakSlot): SeriesId {
  const resourceRef = refOfSlot(s);
  if (s.seriesName) return { channelKey: s.channelKey, key: `series:${s.seriesName}`, kind: 'series', label: s.seriesName, resourceRef };
  if (s.scheduleRuleId) {
    const t = s.topic.replace(/\s+/g, ' ').trim();
    return { channelKey: s.channelKey, key: `rule:${s.scheduleRuleId}`, kind: 'rule', label: `fixed slot "${t.length > 40 ? `${t.slice(0, 39)}…` : t}"`, resourceRef };
  }
  return { channelKey: s.channelKey, key: `resource:${resourceRef}`, kind: 'resource', label: resourceRef, resourceRef };
}

export interface StreakHit extends SeriesId {
  cause:   SkipCause;
  n:       number;
  /** The newest skip's reason line. */
  reason:  string;
  slotIds: string[];
  firstAt: Date;
  lastAt:  Date;
}

/** A streak of plain slots (no series, no pin) must span this long: one quiet evening of "nothing fresh" is not a dead resource. */
export const RESOURCE_MIN_SPAN_MS = 20 * 3600_000;

export interface StreakOptions {
  /** SERIES_SKIP_STREAK; 0 (or less) = off. */
  threshold: number;
  /** Latest resume per `<channelKey>|<series key>`: slots closed before it do not count. */
  resumedAt?: ReadonlyMap<string, Date>;
  resourceMinSpanMs?: number;
}

export const pauseMapKey = (channelKey: string, key: string) => `${channelKey}|${key}`;

/**
 * Every series whose trailing run of same-cause skips reached the threshold (any cause; the breaker pauses only
 * `PAUSING_CAUSES`). Slots may come in any order and may include open ones; only closed slots count.
 */
export function skipStreaks(slots: StreakSlot[], o: StreakOptions): StreakHit[] {
  if (!(o.threshold > 0)) return [];
  const groups = new Map<string, { id: SeriesId; slots: StreakSlot[] }>();
  for (const s of slots) {
    const id = seriesIdOf(s);
    const k = pauseMapKey(id.channelKey, id.key);
    const g = groups.get(k) ?? { id, slots: [] };
    g.slots.push(s);
    groups.set(k, g);
  }
  const out: StreakHit[] = [];
  for (const [k, g] of groups) {
    const cutoff = o.resumedAt?.get(k)?.getTime() ?? 0;
    const ordered = g.slots.filter((s) => s.updatedAt.getTime() > cutoff).sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
    let cause: SkipCause | null = null;
    const run: StreakSlot[] = [];
    for (let i = ordered.length - 1; i >= 0; i--) {
      const c = classifyClose(ordered[i]);
      if (c.k === 'ignore') continue;
      if (c.k !== 'cause' || (cause && c.cause !== cause)) break;
      cause = c.cause;
      run.push(ordered[i]);
    }
    if (!cause || run.length < o.threshold) continue;
    const newest = run[0], oldest = run[run.length - 1];
    if (g.id.kind === 'resource' && newest.scheduledAt.getTime() - oldest.scheduledAt.getTime() < (o.resourceMinSpanMs ?? RESOURCE_MIN_SPAN_MS)) continue;
    out.push({
      ...g.id, cause, n: run.length, reason: reasonLine(newest.error), slotIds: run.map((s) => s.id),
      firstAt: oldest.scheduledAt, lastAt: newest.scheduledAt,
    });
  }
  return out;
}
