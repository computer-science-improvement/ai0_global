import { zonedToUtc } from '../roles/time';
import { addDays, formatLocalStamp, localDay, mentionInstant, parseDateMentions, type DateMention } from '../post/dates';
import { bodyText, excerptOf, type AuditPost } from '../post/integrity/types';

/**
 * Spec 037 FR-003 (T3): announcement → recap, pure. A dated event (a presentation, a release, a stream) gets one
 * announcement and one reminder before it, then a post after it:
 *
 *   • the event of a post: the writer's `story.event_at` (+ `story.event`), else the first future date of the text
 *     that stands in a sentence with an event word («проведе захід 13 жовтня о 16:00 за Києвом», «Анонс очікують
 *     13 жовтня», «виходить на PS5 10 листопада»), parsed by the T5 date parser; a deadline («до 15 жовтня») is not
 *     an event. A date without a time is an all-day event (a release day): it starts at local midnight and lasts the
 *     day;
 *   • before the event: the announcement, then one reminder in the last 24 h (`story.kind: "reminder"`; for a release
 *     day the day itself counts too); any other post of the story without new facts is `story_repeat`;
 *   • 2 h after the event (the end of a release day) a "recap needed" item goes to the planner, the orchestrator and
 *     the writer, ahead of the feed: which event, how many times it was announced, what the announcements showed;
 *   • no post of the story within 24 h after the event → one owner Inbox note per event (`event_not_covered`) and the
 *     `event_not_covered` flag in the MANAGER quality digest.
 */

export const EVENT_REMINDER_HOURS = 24;
export const EVENT_RECAP_AFTER_HOURS = 2;
export const EVENT_COVER_HOURS = 24;
/** The "recap needed" item stays in the prompts this long after the event ends (then the news is stale). */
export const EVENT_RECAP_SHOWN_HOURS = 72;
/** An announced date further than this is a plan, not an event to track. */
export const EVENT_HORIZON_DAYS = 120;

/** The event of a story (as stored in `editor_stories.event_at` + `entities.event`). */
export interface StoryEvent {
  /** Start: the instant (timed) or the local midnight of the day (all-day), ISO. */
  at:     string;
  /** End: = `at` for a timed event, the next local midnight for an all-day event, ISO. */
  end:    string;
  allDay: boolean;
  /** Local day of the event (YYYY-MM-DD) in the resource zone. */
  day:    string;
  /** The event's name: the writer's `story.event`, a «quoted» name of the date's sentence, or the post's first line. */
  name:   string;
  /** The date as the post writes it («13 жовтня о 16:00 за Києвом»); empty for a declared date not found in the text. */
  text:   string;
}

/** Words that make a future date an event: announce, present, hold, release, launch, stream, premiere, appear. */
const EVENT_WORD_RE = /(?<![\p{L}])(?:анонс\p{L}*|презент\p{L}*|представ\p{L}*|покаж\p{L}*|показ\p{L}*|провед\p{L}*|проводит\p{L}*|захід|заходу|заході|поді[яїюй]\p{L}*|конференц\p{L}*|реліз\p{L}*|вийд\p{L}*|вихід|виход\p{L}*|стартує|старт\p{L}*|запуск\p{L}*|прем[ʼ'’]?єр\p{L}*|трансляц\p{L}*|стрім\p{L}*|з[ʼ'’]яв\p{L}*|відбуд\p{L}*|надійд\p{L}*|event|launch\p{L}*|release\p{L}*|keynote|showcase|direct)(?![\p{L}])/iu;

/** Sentence ranges of a text: a sentence ends at «. ! ? …» before a space + capital / quote / end, or at a line break. */
function sentences(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  const re = /[.!?…](?=\s+[\p{Lu}«"„“]|\s*$)|\n/gu;
  for (const m of text.matchAll(re)) {
    const end = m.index! + m[0].length;
    if (end > start) out.push([start, end]);
    start = end;
  }
  if (start < text.length) out.push([start, text.length]);
  return out;
}

const QUOTED_RE = /«([^»\n]{2,60})»|"([^"\n]{2,60})"|“([^”\n]{2,60})”/u;

function firstLine(post: AuditPost): string {
  return excerptOf(post.lead ?? bodyText(post).split('\n').find((l) => l.trim()) ?? '', 90);
}

/** Start and end of an event on `day` (with `time` in `zone`, else all day in `tz`). */
function eventSpan(day: string, time: string | undefined, zone: string | undefined, tz: string): { at: Date; end: Date; allDay: boolean } {
  if (time && zone) {
    const at = zonedToUtc(day, time, zone);
    return { at, end: at, allDay: false };
  }
  return { at: zonedToUtc(day, '00:00', tz), end: zonedToUtc(addDays(day, 1), '00:00', tz), allDay: true };
}

/** A declared `story.event_at`: `YYYY-MM-DD`, `YYYY-MM-DD[T ]HH:MM` (local time of the resource) or an ISO instant. */
export function parseDeclaredEventAt(v: string, tz: string): { day: string; time?: string; instant?: Date } | null {
  const s = v.trim();
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/.exec(s);
  if (m) {
    if (!Number.isFinite(Date.parse(`${m[1]}T00:00:00Z`))) return null;
    if (m[2] === undefined) return { day: m[1] };
    if (Number(m[2]) > 23 || Number(m[3]) > 59) return null;
    const time = `${m[2]}:${m[3]}`;
    return { day: m[1], time, instant: zonedToUtc(m[1], time, tz) };
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) return null;
  const instant = new Date(t);
  const day = localDay(instant.toISOString(), tz);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant);
  return { day, time, instant };
}

/**
 * The day mentions of a text with their (group) time, one per group: the explicit date of the group, else its
 * relative word («вже завтра, 12 жовтня» names 12.10 even when «завтра» is wrong); weekdays alone have no day.
 */
function dayMentions(text: string, post: Pick<AuditPost, 'publishedAt' | 'timezone'>): DateMention[] {
  const all = parseDateMentions(text, { publishedAt: post.publishedAt, timezone: post.timezone || 'Europe/Kyiv' })
    .filter((m) => (m.kind === 'date' || m.kind === 'relative') && !!m.date && !m.historical);
  return all.filter((m) => m.kind === 'date' || !all.some((x) => x.group === m.group && x.kind === 'date'));
}

/** Does the text name the declared date (and its time, when declared)? */
export function textNamesDate(post: AuditPost, declared: { day: string; time?: string; instant?: Date }): DateMention | null {
  for (const m of dayMentions(bodyText(post), post)) {
    if (m.date !== declared.day) continue;
    if (!declared.time) return m;
    const inst = mentionInstant(m);
    if (inst && declared.instant ? inst.getTime() === declared.instant.getTime() : m.time === declared.time) return m;
  }
  return null;
}

/**
 * The event a post announces: the declared `story.event_at`, else the first future date (not a deadline, within
 * 120 days) of the text in a sentence with an event word; null when the post announces nothing.
 */
export function eventOfPost(post: AuditPost): StoryEvent | null {
  const tz = post.timezone || 'Europe/Kyiv';
  const text = bodyText(post);
  const declared = post.story?.eventAt ? parseDeclaredEventAt(post.story.eventAt, tz) : null;
  if (declared) {
    const m = textNamesDate(post, declared);
    const span = eventSpan(declared.day, declared.time, declared.time ? tz : undefined, tz);
    if (declared.instant) { span.at = declared.instant; span.end = declared.instant; }
    return {
      at: span.at.toISOString(), end: span.end.toISOString(), allDay: span.allDay, day: declared.day,
      name: excerptOf(post.story?.eventName || quotedNear(text, m) || firstLine(post), 90), text: m?.text ?? '',
    };
  }
  const publishDay = localDay(post.publishedAt, tz);
  const horizon = addDays(publishDay, EVENT_HORIZON_DAYS);
  const sents = sentences(text);
  for (const m of dayMentions(text, post)) {
    if (m.preposition === 'until' || m.date! < publishDay || m.date! > horizon) continue;
    const inst = mentionInstant(m);
    if (inst && inst.getTime() <= Date.parse(post.publishedAt)) continue;
    const [s, e] = sents.find(([a, b]) => m.span[0] >= a && m.span[0] < b) ?? [0, text.length];
    const sentence = text.slice(s, e);
    if (!EVENT_WORD_RE.test(sentence)) continue;
    const span = eventSpan(m.date!, m.time, m.zone, tz);
    const quoted = QUOTED_RE.exec(sentence);
    return {
      at: span.at.toISOString(), end: span.end.toISOString(), allDay: span.allDay, day: m.date!,
      name: excerptOf(quoted ? (quoted[1] ?? quoted[2] ?? quoted[3]) : firstLine(post), 90), text: groupText(text, m, post),
    };
  }
  return null;
}

/** «13 жовтня о 16:00 за Києвом»: the words of a mention's group. */
function groupText(text: string, m: DateMention, post: AuditPost): string {
  const g = parseDateMentions(text, { publishedAt: post.publishedAt, timezone: post.timezone || 'Europe/Kyiv' }).filter((x) => x.group === m.group);
  return g.length ? text.slice(g[0].span[0], g[g.length - 1].span[1]) : m.text;
}

function quotedNear(text: string, m: DateMention | null): string | null {
  if (!m) return null;
  const sent = sentences(text).find(([a, b]) => m.span[0] >= a && m.span[0] < b);
  const q = sent ? QUOTED_RE.exec(text.slice(sent[0], sent[1])) : null;
  return q ? (q[1] ?? q[2] ?? q[3]) : null;
}

/**
 * The event of a story from its posts (oldest → newest): the newest announced day wins (a moved date), a timed
 * mention of that day (with its name) beats an all-day one, and a post after the start never moves it (a recap's
 * «продажі з 24 жовтня» is a fact of the recap, not a new event).
 */
export function storyEventOf(posts: AuditPost[]): StoryEvent | null {
  let cur: StoryEvent | null = null;
  for (const p of [...posts].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))) cur = mergeEvent(cur, eventOfPost(p), p.publishedAt);
  return cur;
}

/**
 * The stored event after a post with `cand` (`postedAt`): set when none, refined (a time for the same day) or moved
 * (another day) while the stored event has not started; after it starts a post never moves it. Returns the event
 * to keep (`cur` when nothing changes).
 */
export function mergeEvent(cur: StoryEvent | null, cand: StoryEvent | null, postedAt?: string): StoryEvent | null {
  if (!cand) return cur;
  if (!cur) return cand;
  if (postedAt && Date.parse(postedAt) >= Date.parse(cur.at)) return cur;
  if (cand.day === cur.day) return cur.allDay && !cand.allDay ? cand : cur;
  return cand;
}

// ── the story guard's view ──────────────────────────────────────────────────

export type EventVerdict = { role: 'reminder' | 'followup' } | { repeat: string } | null;

/** Is `t` in the reminder window of the event: the last 24 h before it (and a release day itself)? */
export function inReminderWindow(ev: StoryEvent, t: number): boolean {
  const start = Date.parse(ev.at);
  return t > start - EVENT_REMINDER_HOURS * 3_600_000 && t < (ev.allDay ? Date.parse(ev.end) : start);
}

/** «Welcome Home» (вівторок, 13.10.2026 16:00): an event as the prompts and messages show it. */
export function describeEvent(ev: StoryEvent, tz: string): string {
  const stamp = formatLocalStamp(ev.at, tz).replace(/\s*\([^)]*\)$/, '');
  return `«${ev.name}» (${ev.allDay ? stamp.replace(/\s+\d{2}:\d{2}$/, '') : stamp})`;
}

/**
 * Spec 037 T3: the story rule for a post of a story with an announced event (`story` = its earlier and later posts
 * on the resource). Null = no event, or the T2 rules decide (a declared follow-up with new facts, a giveaway / deal
 * with its deadline, a digest, evergreen).
 */
export function eventVerdict(i: {
  post: AuditPost; story: AuditPost[]; kind?: string; deal: boolean; addsFacts: boolean;
}): EventVerdict {
  if (i.deal || i.kind === 'followup' || i.kind === 'roundup' || i.kind === 'evergreen') return null;
  const ev = storyEventOf([...i.story, i.post]);
  if (!ev) return null;
  const tz = i.post.timezone || 'Europe/Kyiv';
  const t = Date.parse(i.post.publishedAt);
  const start = Date.parse(ev.at);
  const earlier = i.story.filter((p) => Date.parse(p.publishedAt) < t).sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  // An earlier reminder: declared, or (an export) a later post of the window than the story's first one.
  const reminder = earlier.find((p, idx) => p.story?.kind === 'reminder' || (!p.story && idx > 0 && inReminderWindow(ev, Date.parse(p.publishedAt))));
  const what = describeEvent(ev, tz);
  const pre = earlier.filter((p) => Date.parse(p.publishedAt) < start).length;
  const hoursLeft = Math.round((start - t) / 3_600_000);

  if (i.kind === 'reminder') {
    if (inReminderWindow(ev, t) && !reminder) return { role: 'reminder' };
    if (reminder) return { repeat: `нагадування про подію ${what} уже було (${formatLocalStamp(reminder.publishedAt, tz)}) — одне на подію` };
    if (t >= (ev.allDay ? Date.parse(ev.end) : start)) {
      return { repeat: `подія ${what} уже почалася — тепер потрібен підсумок: story.followup_of + kind "followup" + new_facts (що показали)` };
    }
    return { repeat: `нагадування про подію ${what} — лише в останні ${EVENT_REMINDER_HOURS} год до неї (до події ${hoursLeft} год)` };
  }
  // An export (no declared story): a post after the start that adds new facts (names, numbers, dates of weight ≥ 2) is
  // the recap; one post of the window is the reminder.
  if (!i.post.story) {
    if (t >= start && i.addsFacts) return { role: 'followup' };
    if (inReminderWindow(ev, t) && !reminder && earlier.length) return { role: 'reminder' };
  }
  if (t >= start) {
    return { repeat: `подія ${what} уже відбулася — підсумок оформи як продовження: story.followup_of + kind "followup" + new_facts (що показали, ціни, дати)` };
  }
  return {
    repeat: `подію ${what} уже анонсовано (${pre} пост(и)): до неї — лише одне нагадування в останні ${EVENT_REMINDER_HOURS} год (story.kind "reminder"`
      + `${hoursLeft > EVENT_REMINDER_HOURS ? `, через ${hoursLeft - EVENT_REMINDER_HOURS} год` : ''}), після — підсумок`,
  };
}

// ── recap needed / not covered ──────────────────────────────────────────────

/** A story with an event as the registry holds it, with its posts on every resource of the scope. */
export interface EventStory {
  storyId: string;
  key:     string;
  title:   string;
  event:   StoryEvent;
  posts:   Array<{ resourceRef: string; role: string; at: string; lead: string; ref: string | null }>;
}

export interface RecapItem {
  storyId:     string;
  key:         string;
  resourceRef: string;
  event:       StoryEvent;
  /** Posts of the resource before the event (the announcement and the reminder). */
  announced:   number;
  /** What the announcements showed: their first lines (oldest first, ≤ 3). */
  shown:       string[];
  /** The resource's first post of the story (the `followup_of` of the recap). */
  originalRef: string | null;
}

const RECAP_SHOWN = 3;

/** Posts of a resource that announced the event and whether one covers it (a post from the start on, not a reminder). */
function coverageOf(s: EventStory, ref: string): { announced: EventStory['posts']; covered: boolean } {
  const start = Date.parse(s.event.at);
  const own = s.posts.filter((p) => p.resourceRef === ref).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    announced: own.filter((p) => Date.parse(p.at) < start && p.role !== 'repost'),
    covered: own.some((p) => Date.parse(p.at) >= start && p.role !== 'reminder'),
  };
}

function recapItem(s: EventStory, ref: string): RecapItem | null {
  const c = coverageOf(s, ref);
  if (!c.announced.length || c.covered) return null;
  return {
    storyId: s.storyId, key: s.key, resourceRef: ref, event: s.event, announced: c.announced.length,
    shown: c.announced.slice(0, RECAP_SHOWN).map((p) => excerptOf(p.lead, 120)).filter(Boolean),
    originalRef: c.announced[0]?.ref ?? null,
  };
}

/** The events a resource announced that need a recap at `now`: from 2 h after the event (end) for 72 h, not covered. */
export function recapNeeded(stories: EventStory[], resourceRef: string, now: Date): RecapItem[] {
  const t = now.getTime();
  return stories.filter((s) => {
    const end = Date.parse(s.event.end);
    return t >= end + EVENT_RECAP_AFTER_HOURS * 3_600_000 && t < end + EVENT_RECAP_SHOWN_HOURS * 3_600_000;
  }).map((s) => recapItem(s, resourceRef)).filter((x): x is RecapItem => !!x)
    .sort((a, b) => Date.parse(a.event.end) - Date.parse(b.event.end));
}

/**
 * The "recap needed" block of the planner, orchestrator and writer prompts (null when nothing is due). It goes
 * before the feed and the active stories: a recap of an announced event comes first.
 */
export function recapNeededBlock(items: RecapItem[], o: { timezone: string; role: 'planner' | 'executor' }): string | null {
  if (!items.length) return null;
  const rule = o.role === 'planner'
    ? 'Ці події ресурс анонсував, а підсумку ще немає. Підсумок важливіший за звичайні записи фіду: заплануй його першим (що показали, ціни, дати виходу), або свідомо пропусти, якщо подію скасували.'
    : 'Ці події ресурс анонсував, а підсумку ще немає — він важливіший за звичайні записи фіду. Підсумок = продовження: story { followup_of: <оригінал>, kind: "followup", new_facts: [що показали] } (піде відповіддю на анонс). Без нових фактів із джерела не пиши.';
  const lines = items.map((r) => {
    const parts = [`- ${r.key}: подія ${describeEvent(r.event, o.timezone)}`, `анонсовано ${r.announced} раз(и)`];
    if (r.originalRef) parts.push(`оригінал ${r.originalRef}`);
    if (r.shown.length) parts.push(`показали в анонсах: ${r.shown.map((s) => `«${excerptOf(s, 90)}»`).join('; ')}`);
    return parts.join(' · ');
  });
  return ['## Потрібен підсумок (recap needed)', rule, ...lines].join('\n');
}

export interface EventGap {
  storyId:   string;
  key:       string;
  title:     string;
  event:     StoryEvent;
  /** Resources that announced the event and have no post about it within 24 h after it. */
  resources: Array<{ ref: string; announced: number; shown: string[] }>;
}

/**
 * Announced events with no post within 24 h after them (end + 24 h ≤ now), each with the resources that announced
 * and did not cover it; `since` limits how old the event may be (alerts: 72 h, the digest: its window).
 */
export function eventsNotCovered(stories: EventStory[], now: Date, since: Date): EventGap[] {
  const out: EventGap[] = [];
  for (const s of stories) {
    const due = Date.parse(s.event.end) + EVENT_COVER_HOURS * 3_600_000;
    if (due > now.getTime() || due < since.getTime()) continue;
    const refs = [...new Set(s.posts.map((p) => p.resourceRef))].sort();
    const resources = refs.map((ref) => {
      // Covered only by a post within the 24 h (a recap a week later is late, but it is a recap: count it).
      const c = coverageOf(s, ref);
      return !c.announced.length || c.covered ? null : { ref, announced: c.announced.length, shown: c.announced.slice(0, RECAP_SHOWN).map((p) => excerptOf(p.lead, 120)) };
    }).filter((x): x is EventGap['resources'][number] => !!x);
    if (resources.length) out.push({ storyId: s.storyId, key: s.key, title: s.title, event: s.event, resources });
  }
  return out.sort((a, b) => Date.parse(a.event.at) - Date.parse(b.event.at));
}

/** The dedup key of the one Inbox note per event: ref_type `story_event`, ref_id `<story id>|<event start>`. */
export const EVENT_REF_TYPE = 'story_event';
export function eventRef(storyId: string, ev: Pick<StoryEvent, 'at'>): { refType: string; refId: string } {
  return { refType: EVENT_REF_TYPE, refId: `${storyId}|${new Date(ev.at).toISOString()}` };
}

/** The owner's Inbox note of an uncovered event (English: dashboard copy). */
export function eventNote(g: EventGap, tz: string): { title: string; body: string } {
  const when = formatLocalStamp(g.event.at, tz).replace(/^[^,]+,\s*/, '');
  const day = g.event.allDay ? when.replace(/\s+\d{2}:\d{2}(?=\s*\()/, '') : when;
  const lines = g.resources.map((r) => `• ${r.ref}: announced ${r.announced} time(s)${r.shown.length ? `, e.g. «${excerptOf(r.shown[0], 100)}»` : ''}`);
  return {
    title: `Announced event got no recap: «${excerptOf(g.event.name, 80)}»`,
    body: [
      `The event "${excerptOf(g.event.name, 80)}" (${day}) was announced, but no post about it went out within ${EVENT_COVER_HOURS} h after it.`,
      ...lines,
      'Plan a recap with what was shown (prices, dates), or note why it is skipped. The planner already sees it as "recap needed".',
    ].join('\n'),
  };
}

/** Stored JSON of an event (`editor_stories.entities.event`) ↔ StoryEvent. */
export function eventToJson(ev: StoryEvent): Record<string, unknown> {
  return { name: ev.name, all_day: ev.allDay, day: ev.day, end: ev.end, text: ev.text };
}

export function eventFromRow(eventAt: Date | string | null, json: unknown): StoryEvent | null {
  if (!eventAt) return null;
  const at = new Date(eventAt);
  if (!Number.isFinite(at.getTime())) return null;
  const j = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const allDay = j.all_day === true;
  const end = typeof j.end === 'string' && Number.isFinite(Date.parse(j.end)) ? new Date(j.end) : new Date(at.getTime() + (allDay ? 86_400_000 : 0));
  return {
    at: at.toISOString(), end: end.toISOString(), allDay, day: typeof j.day === 'string' ? j.day : at.toISOString().slice(0, 10),
    name: typeof j.name === 'string' && j.name ? j.name : '', text: typeof j.text === 'string' ? j.text : '',
  };
}
