import type { Pool } from 'pg';
import { DEFAULT_POLLS_PER_WEEK, isPollFormat, POLL_FORMATS } from '../audience-asks';
import { exemptSeries, POLL_WINDOW_DAYS, type SeriesLike } from '../../roles/poll-cap';
import { localDate } from '../../roles/time';

/**
 * Spec 037 FR-007 (T7): `poll_cap_reached` before publishing. The plan validators (`roles/poll-cap.ts`,
 * `pollCapErrors`) count planned slots; this guard counts what is really out or about to go out — published polls and
 * quizzes of the Telegram channel (agent slots and chat posts alike), and the ones waiting for the owner or approved —
 * so a live slot, a chat post or an approval-mode post cannot pass the weekly cap the plan was checked against.
 *
 * Same rule as the plan validators: at most `polls_per_week` poll + quiz posts in any 7 local days of the resource
 * (POLL_WINDOW_DAYS); instances of a series the owner created or a strategy migration brought (origin owner /
 * migration, or locked) do not count and are never blocked. A post counts once (a published slot and its
 * published_posts row are one post).
 */

const DAY_MS = 86_400_000;

/** The local day number (days since 1970-01-01 in the zone) of an instant. */
export function localDayIndex(at: Date, tz: string): number {
  return Math.round(Date.parse(`${localDate(at, tz)}T00:00:00Z`) / DAY_MS);
}

/**
 * The most polls already in one window of `windowDays` local days that also holds `day` (the new post's day). Windows
 * may reach into the future: a poll waiting for approval on Friday shares a week with one published on Tuesday.
 */
export function maxPollsInWindow(days: readonly number[], day: number, windowDays = POLL_WINDOW_DAYS): number {
  let best = 0;
  for (let start = day - windowDays + 1; start <= day; start++) {
    const n = days.filter((d) => d >= start && d < start + windowDays).length;
    if (n > best) best = n;
  }
  return best;
}

export interface PollCapGuardInput {
  channelKey: string;
  /** The post's format; anything but poll / quiz passes. */
  format: string;
  /** Scheduled (or now) publish instant of the new post. */
  at: Date;
  timezone: string;
  /** `polls_per_week` of the resource: null = no cap, undefined = the default (1). */
  cap: number | null | undefined;
  /** The slot being published (left out of the count); null for a chat post published right away. */
  slotId?: string | null;
  /** The slot's series, when it is an instance of one. */
  series?: string | null;
  /** The network playbook's series (exempt ones: origin owner / migration, or locked). */
  playbookSeries?: readonly SeriesLike[];
}

export interface PollCapRow { at: Date; series: string | null }

/**
 * Poll / quiz posts of the channel around `at` (± the window): published (published_posts, joined to the slot for its
 * series; a published slot without its row counts by the slot) and the slots waiting for approval or approved. Other resources of a network slot (`resource_ref` of another
 * platform) are not the Telegram channel and are left out.
 */
export async function loadPollPosts(pool: Pick<Pool, 'query'>, i: Pick<PollCapGuardInput, 'channelKey' | 'at' | 'slotId'>): Promise<PollCapRow[]> {
  const from = new Date(i.at.getTime() - (POLL_WINDOW_DAYS + 1) * DAY_MS);
  const to = new Date(i.at.getTime() + (POLL_WINDOW_DAYS + 1) * DAY_MS);
  const { rows } = await pool.query(
    `SELECT p.posted_at AS at,
            COALESCE(s.series_name, (SELECT substr(h, 8) FROM jsonb_array_elements_text(COALESCE(s.source_hints, '[]'::jsonb)) h WHERE h LIKE 'series:%' LIMIT 1)) AS series
       FROM published_posts p
       LEFT JOIN editor_slots s ON s.id = p.editor_slot_id
      WHERE p.channel_id = $1::text AND p.format = ANY($2::text[]) AND p.posted_at >= $3 AND p.posted_at < $4
        AND ($5::uuid IS NULL OR p.editor_slot_id IS DISTINCT FROM $5::uuid)
     UNION ALL
     SELECT s.scheduled_at AS at,
            COALESCE(s.series_name, (SELECT substr(h, 8) FROM jsonb_array_elements_text(COALESCE(s.source_hints, '[]'::jsonb)) h WHERE h LIKE 'series:%' LIMIT 1)) AS series
       FROM editor_slots s
      WHERE s.channel_key = $1::text AND (s.resource_ref IS NULL OR s.resource_ref = 'telegram:' || s.channel_key)
        AND s.format = ANY($2::text[])
        AND (s.status IN ('awaiting_approval', 'approved')
             OR (s.status = 'published' AND NOT EXISTS (SELECT 1 FROM published_posts q WHERE q.editor_slot_id = s.id)))
        AND s.scheduled_at >= $3 AND s.scheduled_at < $4
        AND ($5::uuid IS NULL OR s.id <> $5::uuid)`,
    [i.channelKey, [...POLL_FORMATS], from, to, i.slotId ?? null]);
  return (rows ?? []).map((r: any) => ({ at: new Date(r.at), series: r.series ?? null }));
}

/** The guard result: null when the post may go out. */
export function pollCapIssue(i: PollCapGuardInput, rows: readonly PollCapRow[]): { error: 'poll_cap_reached'; details: string } | null {
  if (!isPollFormat(i.format)) return null;
  const cap = i.cap === undefined ? DEFAULT_POLLS_PER_WEEK : i.cap;
  if (cap === null) return null;
  const exempt = exemptSeries(i.playbookSeries ?? []);
  if (i.series && exempt.has(i.series)) return null;
  const days = rows.filter((r) => !r.series || !exempt.has(r.series)).map((r) => localDayIndex(r.at, i.timezone));
  const before = maxPollsInWindow(days, localDayIndex(i.at, i.timezone));
  if (before + 1 <= cap) return null;
  return {
    error: 'poll_cap_reached',
    details: `опитувань і вікторин за ${POLL_WINDOW_DAYS} днів уже ${before} (опубліковані, схвалені й ті, що чекають апруву) — ліміт ресурсу ${cap} на тиждень (polls_per_week). Зроби з цього слоту text чи photo без опитування або skip_slot; підвищити ліміт може лише власник.`,
  };
}

/** The series a slot is an instance of (the column, else the `series:` source hint). */
export function slotSeriesOf(slot: { seriesName?: string | null; sourceHints?: readonly string[] | null }): string | null {
  return slot.seriesName ?? slot.sourceHints?.find((h) => h.startsWith('series:'))?.slice('series:'.length) ?? null;
}

/** Load + decide; formats other than poll / quiz never touch the DB. */
export async function pollCapGuard(pool: Pick<Pool, 'query'>, i: PollCapGuardInput) {
  if (!isPollFormat(i.format)) return null;
  if (i.cap === null) return null;
  return pollCapIssue(i, await loadPollPosts(pool, i));
}
