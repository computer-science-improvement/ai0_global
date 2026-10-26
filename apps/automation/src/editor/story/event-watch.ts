import type { Pool } from 'pg';
import type { InboxItemInput, OwnerInbox } from '../agents/owner-inbox';
import { eventNote, eventRef, eventsNotCovered, EVENT_COVER_HOURS, EVENT_REF_TYPE, type EventStory } from './story-event';
import { StoryEventRepository } from './story-event.repository';
import { errText } from '../../common/err-text';

/**
 * Spec 037 FR-003 (T3): the owner's Inbox note about an announced event that got no post within 24 h after it
 * (`event_not_covered`): one note per event (`OwnerInbox.postOnce`, ref `story_event` / `<story id>|<event start>`),
 * computed by code from the story registry (no LLM). Runs from the editor scheduler's minute tick, throttled like the
 * silent-day check; events whose 24 h ran out more than 48 h ago are not alerted any more (a restart after a long
 * pause does not flood the Inbox).
 */

export const EVENT_CHECK_EVERY_MS = 5 * 60_000;
/** How long after the 24 h ran out an uncovered event is still alerted. */
export const EVENT_ALERT_GRACE_HOURS = 48;

export interface EventWatchDeps {
  inbox:    Pick<OwnerInbox, 'postOnce'> & Partial<Pick<OwnerInbox, 'markRead'>>;
  /** Spec 069 A6: the unread `event_not_covered` notes (default: read from `pool`). */
  openNotes?: () => Promise<Array<{ id: number; refId: string }>>;
  /** The stories whose event starts in [from, to] (default: the story registry). */
  stories?: (from: Date, to: Date) => Promise<EventStory[]>;
  /** The resource zone the note's date is written in (default: `resource_tz(ref)`, else Europe/Kyiv). */
  tzOf?:    (ref: string) => Promise<string>;
  pool?:    Pick<Pool, 'query'>;
  everyMs?: number;
  log?:     (m: string) => void;
}

export class EventRecapWatch {
  private lastRun = 0;

  constructor(private readonly d: EventWatchDeps) {}

  private async tz(ref: string): Promise<string> {
    if (this.d.tzOf) return this.d.tzOf(ref).catch(() => 'Europe/Kyiv');
    if (!this.d.pool) return 'Europe/Kyiv';
    const { rows } = await this.d.pool.query(`SELECT resource_tz($1) AS tz`, [ref]).catch(() => ({ rows: [] as any[] }));
    return rows[0]?.tz || 'Europe/Kyiv';
  }

  /** Throttled check from the scheduler tick; returns the number of new Inbox notes. */
  async check(now: Date): Promise<number> {
    const every = this.d.everyMs ?? EVENT_CHECK_EVERY_MS;
    if (every > 0 && now.getTime() - this.lastRun < every) return 0;
    this.lastRun = now.getTime();
    const since = new Date(now.getTime() - EVENT_ALERT_GRACE_HOURS * 3_600_000);
    const from = new Date(since.getTime() - (EVENT_COVER_HOURS + 24) * 3_600_000);
    const load = this.d.stories ?? ((a: Date, b: Date) => new StoryEventRepository(this.d.pool!).eventStories(a, b));
    const gaps = eventsNotCovered(await load(from, now), now, since);
    let n = 0;
    for (const g of gaps) {
      const note = eventNote(g, await this.tz(g.resources[0].ref));
      const item: InboxItemInput & { refType: string; refId: string } = {
        agentId: null, kind: 'event_not_covered', severity: 'action', title: note.title, body: note.body, ...eventRef(g.storyId, g.event),
      };
      try {
        if ((await this.d.inbox.postOnce(item)) != null) n++;
      } catch (err: any) {
        this.d.log?.(`event note for ${g.key} failed: ${errText(err)}`);
      }
    }
    await this.closeSettled(new Set(gaps.map((g) => eventRef(g.storyId, g.event).refId)));
    return n;
  }

  /**
   * Spec 069 A6: an unread `event_not_covered` note whose event is no longer an open gap — a recap came out, or the alert
   * grace ran out — is marked read (the owner-bot sweep then closes its card). The note itself is never re-posted: its ref
   * is the event's own, so the second identical check posts nothing.
   */
  private async closeSettled(open: ReadonlySet<string>): Promise<void> {
    if (!this.d.inbox.markRead) return;
    try {
      const notes = await (this.d.openNotes ?? (() => this.unreadNotes()))();
      const settled = notes.filter((x) => !open.has(x.refId)).map((x) => x.id);
      if (settled.length) await this.d.inbox.markRead(settled);
    } catch (err: any) {
      this.d.log?.(`event notes not closed: ${errText(err)}`);
    }
  }

  private async unreadNotes(): Promise<Array<{ id: number; refId: string }>> {
    if (!this.d.pool) return [];
    const { rows } = await this.d.pool.query(
      `SELECT id, ref_id FROM agent_inbox WHERE kind = 'event_not_covered' AND ref_type = $1 AND read_at IS NULL`, [EVENT_REF_TYPE]);
    return rows.map((r: any) => ({ id: Number(r.id), refId: String(r.ref_id) }));
  }
}
