import type { Pool } from 'pg';
import type { AuditPost } from '../post/integrity/types';
import {
  eventFromRow, eventOfPost, eventsNotCovered, eventToJson, mergeEvent, recapNeeded, EVENT_COVER_HOURS, EVENT_RECAP_SHOWN_HOURS,
  type EventGap, type EventStory, type RecapItem, type StoryEvent,
} from './story-event';

/**
 * Spec 037 T3: the events of the story registry (no migration: `editor_stories.event_at` of 073 holds the start,
 * `editor_stories.entities.event` the name, the all-day flag and the end). A post that joins a story notes the event
 * it announces; the prompts read the events that need a recap, the Inbox watch and the MANAGER digest the events
 * nobody covered.
 */

/** The slot statuses a story post counts (as story.repository STORY_SLOT_STATUSES; a skipped / failed slot never went out). */
const COUNTED = ['published', 'shadowed', 'awaiting_approval', 'approved'];
/** The roles whose post may announce (or refine) the event; a digest, a repost and evergreen never do. */
const ANNOUNCING = new Set(['original', 'followup', 'reminder']);

const storyPostRef = (r: { slot_id?: string | null; published_post_id?: number | string | null }): string | null =>
  r.slot_id ? String(r.slot_id) : r.published_post_id != null ? `pp:${r.published_post_id}` : null;

export class StoryEventRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  /**
   * The event a post of the story announces, merged into the stored one (set, refined with a time, moved to another
   * day before it starts; never moved by a post after the start). Returns the stored event, or null when none.
   */
  async noteEvent(storyId: string, post: AuditPost, role: string, postedAt: Date): Promise<StoryEvent | null> {
    if (!ANNOUNCING.has(role)) return null;
    const cand = eventOfPost(post);
    if (!cand) return null;
    const { rows } = await this.pool.query(`SELECT event_at, entities->'event' AS event FROM editor_stories WHERE id = $1`, [storyId]);
    if (!rows[0]) return null;
    const cur = eventFromRow(rows[0].event_at, rows[0].event);
    const next = mergeEvent(cur, cand, postedAt.toISOString());
    if (!next || (cur && next.at === cur.at && next.end === cur.end && next.name === cur.name)) return cur;
    await this.pool.query(
      `UPDATE editor_stories SET event_at = $2, entities = COALESCE(entities, '{}'::jsonb) || jsonb_build_object('event', $3::jsonb), updated_at = now()
        WHERE id = $1`, [storyId, next.at, JSON.stringify(eventToJson(next))]);
    return next;
  }

  /** Stories whose event starts in [from, to], with their counted posts on every resource of the scope. */
  async eventStories(from: Date, to: Date): Promise<EventStory[]> {
    const { rows } = await this.pool.query(
      `SELECT st.id, st.story_key, st.title, st.event_at, st.entities->'event' AS event,
              sp.resource_ref, sp.role, sp.posted_at, sp.lead, sp.slot_id, sp.published_post_id
         FROM editor_stories st
         JOIN editor_story_posts sp ON sp.story_id = st.id
         LEFT JOIN editor_slots s ON s.id = sp.slot_id
        WHERE st.event_at IS NOT NULL AND st.event_at BETWEEN $1 AND $2 AND st.status = 'active'
          AND (sp.slot_id IS NULL OR s.status = ANY($3::text[]))
        ORDER BY st.event_at, sp.posted_at LIMIT 5000`, [from, to, COUNTED]);
    const byId = new Map<string, EventStory>();
    for (const r of rows) {
      let s = byId.get(r.id);
      if (!s) {
        const event = eventFromRow(r.event_at, r.event);
        if (!event) continue;
        s = { storyId: String(r.id), key: r.story_key, title: r.title, event: { ...event, name: event.name || r.title }, posts: [] };
        byId.set(r.id, s);
      }
      s.posts.push({ resourceRef: r.resource_ref, role: r.role, at: new Date(r.posted_at).toISOString(), lead: r.lead ?? '', ref: storyPostRef(r) });
    }
    return [...byId.values()];
  }

  /** The events the channel announced that need a recap now (2 h after the event, for 72 h). */
  async recapItems(channelKey: string, now: Date): Promise<RecapItem[]> {
    const span = (EVENT_RECAP_SHOWN_HOURS + 24) * 3_600_000;
    return recapNeeded(await this.eventStories(new Date(now.getTime() - span), now), `telegram:${channelKey}`, now);
  }

  /** Events with no post within 24 h after them, whose 24 h ran out in [since, now]. */
  async gaps(now: Date, since: Date): Promise<EventGap[]> {
    const from = new Date(since.getTime() - (EVENT_COVER_HOURS + 24) * 3_600_000);
    return eventsNotCovered(await this.eventStories(from, now), now, since);
  }

  /** The uncovered events per resource (MANAGER digest window). */
  async gapsByRef(refs: string[], since: Date, now: Date): Promise<Map<string, EventGap[]>> {
    const out = new Map<string, EventGap[]>();
    if (!refs.length) return out;
    for (const g of await this.gaps(now, since)) {
      for (const r of g.resources) {
        if (!refs.includes(r.ref)) continue;
        out.set(r.ref, [...(out.get(r.ref) ?? []), { ...g, resources: [r] }]);
      }
    }
    return out;
  }
}
