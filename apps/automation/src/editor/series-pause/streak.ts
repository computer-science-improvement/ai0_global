import { classifyClose, reasonLine, type PauseCause, type SkipCause } from './skip-cause';

/**
 * Spec 060 FR-001 / spec 068 FR-003: the streak counter. The consecutive closed slots of one series with the same cause
 * family, counted from the newest backwards (critic closes are transparent). Same series = same `series_name`, else the
 * same `schedule_rule_id`, else the resource (the channel itself for a plain slot).
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
  /** The pause cause (the 093 CHECK set): `no_material` when any member of the run is no_material / source_used, else `source_unreachable`. */
  cause:   PauseCause;
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
 * The run family of a close (spec 068 FR-003). `no_material`, `source_used` and `source_unreachable` are one family for a
 * series or a pin ("nothing to post from"); a plain resource keeps a source that cannot be read apart from a source that
 * is empty or spent, so a mixed run does not add up. Everything else (a post, quality, other) ends a run; the critic is
 * transparent and never reaches here.
 */
type Family = 'material' | 'unreachable';
function familyOf(cause: SkipCause, kind: SeriesKind): Family | null {
  if (cause === 'no_material' || cause === 'source_used') return 'material';
  if (cause === 'source_unreachable') return kind === 'resource' ? 'unreachable' : 'material';
  return null;
}

/**
 * Every series whose trailing run of skips of one family reached the threshold; each hit is a pause cause
 * (`PAUSING_CAUSES`). Critic closes are transparent: they neither count nor end a run. Slots may come in any order and
 * may include open ones; only closed slots count.
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
    let family: Family | null = null;
    const causes = new Set<SkipCause>();
    const run: StreakSlot[] = [];
    for (let i = ordered.length - 1; i >= 0; i--) {
      const c = classifyClose(ordered[i]);
      if (c.k === 'ignore') continue;
      if (c.k !== 'cause') break;                                  // a post or an unclassified skip ends the run
      if (c.cause === 'critic') continue;                          // transparent
      const f = familyOf(c.cause, g.id.kind);
      if (!f || (family && f !== family)) break;                   // quality or another family ends it
      family = f;
      causes.add(c.cause);
      run.push(ordered[i]);
    }
    if (!family || run.length < o.threshold) continue;
    const newest = run[0], oldest = run[run.length - 1];
    if (g.id.kind === 'resource' && newest.scheduledAt.getTime() - oldest.scheduledAt.getTime() < (o.resourceMinSpanMs ?? RESOURCE_MIN_SPAN_MS)) continue;
    const cause: PauseCause = causes.has('no_material') || causes.has('source_used') ? 'no_material' : 'source_unreachable';
    out.push({
      ...g.id, cause, n: run.length, reason: reasonLine(newest.error), slotIds: run.map((s) => s.id),
      firstAt: oldest.scheduledAt, lastAt: newest.scheduledAt,
    });
  }
  return out;
}
