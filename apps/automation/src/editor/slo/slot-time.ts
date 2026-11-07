/**
 * Spec 091 FR-003: where in the day a slot the system adds itself can go, shared by the news watch (live slots 15-30 min
 * ahead) and the SLO controller (replacement and recovery slots). Moved here from `live/news-watch.ts`; the SQL and the
 * rules are the same: outside quiet hours, at least `minGapMinutes` from every post of the channel, inside the local day.
 */
import type { Pool } from 'pg';
import type { EditorCard } from '../card';
import { isQuietHour, localHour, zonedToUtc } from '../roles/time';

/** Statuses of a slot that is on the channel's timeline (will post, is posting, or posted). */
export const ACTIVE_SLOT_STATUSES = `('planned','running','awaiting_approval','approved','published','shadowed')`;

type Q = Pick<Pool, 'query'>;

/** The times (ms) of the channel's own slots within a day of `around`, plus its last published post. */
async function takenTimes(pool: Q, card: Pick<EditorCard, 'channelKey'>, around: Date): Promise<number[]> {
  const { rows } = await pool.query(
    `SELECT scheduled_at AS at FROM editor_slots
      WHERE channel_key = $1 AND resource_ref IS NULL AND status IN ${ACTIVE_SLOT_STATUSES}
        AND scheduled_at BETWEEN $2::timestamptz - interval '1 day' AND $2::timestamptz + interval '1 day'
     UNION ALL
     SELECT max(posted_at) FROM published_posts WHERE channel_id = $3`, [card.channelKey, around, card.channelKey]);
  return rows.map((r: any) => (r.at ? new Date(r.at).getTime() : null)).filter((x): x is number => x != null);
}

type TimeCard = Pick<EditorCard, 'channelKey' | 'timezone' | 'quietStartHour' | 'quietEndHour' | 'minGapMinutes'>;

/** The first of now + `leadMinutes` outside quiet hours and >= min_gap from every post of the channel (news watch: 15/20/25/30). */
export async function freeTime(pool: Q, card: TimeCard, now: Date, leadMinutes: readonly number[]): Promise<Date | null> {
  const gap = card.minGapMinutes * 60_000;
  const taken = await takenTimes(pool, card, now);
  const base = Math.ceil(now.getTime() / 60_000) * 60_000;
  for (const m of leadMinutes) {
    const t = base + m * 60_000;
    if (isQuietHour(localHour(new Date(t), card.timezone), card.quietStartHour, card.quietEndHour)) continue;
    if (taken.every((x) => Math.abs(x - t) >= gap)) return new Date(t);
  }
  return null;
}

/**
 * Spec 091 FR-003: the earliest minute >= `now + leadMin` on the local day `day` that is outside quiet hours, >= min_gap from
 * every post of the channel and not after the day's end (23:59 local). Null when the day has no such minute left.
 */
export async function earliestFreeTime(pool: Q, card: TimeCard, day: string, now: Date, leadMin: number): Promise<Date | null> {
  const gap = card.minGapMinutes * 60_000;
  const dayStart = zonedToUtc(day, '00:00', card.timezone).getTime();
  const dayEnd = zonedToUtc(day, '23:59', card.timezone).getTime();
  const taken = await takenTimes(pool, card, now);
  const from = Math.max(Math.ceil((now.getTime() + leadMin * 60_000) / 60_000) * 60_000, dayStart);
  for (let t = from; t <= dayEnd; t += 60_000) {
    if (isQuietHour(localHour(new Date(t), card.timezone), card.quietStartHour, card.quietEndHour)) continue;
    const clash = taken.find((x) => Math.abs(x - t) < gap);
    if (clash === undefined) return new Date(t);
    t = Math.max(t, clash + gap - 60_000);        // jump past the clash (the loop adds the minute back)
  }
  return null;
}

/** Why the day has no room for one more news-watch slot (null = it has). */
export async function roomBlock(
  pool: Q, card: Pick<EditorCard, 'channelKey' | 'timezone' | 'postsPerDayMax'>, maxPerDay: number, date: string, now: Date,
): Promise<string | null> {
  if (maxPerDay <= 0) return 'daily_cap';
  const from = zonedToUtc(date, '00:00', card.timezone);
  const to = new Date(from.getTime() + 86_400_000);
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE live_spec->>'origin' = 'news_watch')::int AS watch,
            count(*) FILTER (WHERE status IN ${ACTIVE_SLOT_STATUSES})::int AS active
       FROM editor_slots WHERE channel_key = $1 AND resource_ref IS NULL AND scheduled_at >= $2 AND scheduled_at < $3`,
    [card.channelKey, from, to]);
  if (Number(rows[0]?.watch ?? 0) >= maxPerDay) return 'daily_cap';
  const { rows: pub } = await pool.query(
    `SELECT count(*)::int AS n FROM published_posts WHERE channel_id = $1 AND posted_at >= $2`, [card.channelKey, from]);
  if (Math.max(Number(rows[0]?.active ?? 0), Number(pub[0]?.n ?? 0)) >= card.postsPerDayMax) return 'day_full';
  if (now.getTime() >= to.getTime()) return 'day_over';
  return null;
}
