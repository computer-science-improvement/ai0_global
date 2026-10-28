// Spec 078 B4: the pure logic of the Calendar page (/app/calendar): the 5-day window and its `?from=`, one row per Telegram
// orchestrator plus an "Other channels" row, and the chips of a cell. A chip is a slot the planner wrote (with the
// status mark of lib/status-tone.ts), a series or pin the planner has not written yet ("not planned"), or a post the
// owner scheduled ("yours"). No React here, so the node tests can import it (calendar.test.ts).
//
// Time zones: an agent's slots, series and pins sit on the resource's own local date and time (the same rule as the
// agent's Schedule tab); the owner's posts sit on the Kyiv date, because the owner types them in Kyiv time.

import type { AgentNode, SeriesPause } from '../api/agents';
import type { RuleInput, ScheduleResource, ScheduleResponse, ScheduleSlot } from '../api/schedule';
import type { EditorMode, ScheduledPost, TrackedChannel } from '../api/types';
import { cellEntries, type Entry } from './schedule-grid';
import { MARK_LABEL, publicationLabel, slotMark, type MarkKind } from './status-tone';
import { KYIV_TZ, dayIn, formatIn, zoneLabel, zonedToUtc } from './zoned-time';
import { skipReason } from './slot-plan';

// ── the window ─────────────────────────────────────────────────────────────────

/** The grid shows this many days, starting at `?from=` (default: today in Kyiv). */
export const WINDOW_DAYS = 5;
/** The composer's default time of day (Kyiv). */
export const DEFAULT_TIME = '12:00';
/** A cell shows this many chips; the rest sits behind "+N more". */
export const CELL_CHIPS = 5;
/** "Ask the agent" needs a slot at least this far away: the agent writes the post when its slot comes. */
export const ASK_LEAD_MIN = 5;
/** `?from=` further than this from today is ignored (a typo in a link must not render an empty year). */
const FROM_RANGE_DAYS = 400;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const utc = (day: string) => { const [y, m, d] = day.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };

/** A real calendar day written as `YYYY-MM-DD` (2026-02-30 is not one). */
export function isDay(v: unknown): v is string {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return false;
  return utc(v).toISOString().slice(0, 10) === v;
}

/** `HH:MM`, 24-hour. */
export function isTime(v: unknown): v is string {
  return typeof v === 'string' && TIME_RE.test(v);
}

/** Calendar arithmetic on `YYYY-MM-DD` (UTC-based: no browser zone or DST can shift it). */
export function addDays(day: string, by: number): string {
  const d = utc(day);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

/** The window's days, `from` first. */
export function windowDays(from: string, n: number = WINDOW_DAYS): string[] {
  return Array.from({ length: n }, (_, i) => addDays(from, i));
}

/** Today in Kyiv (what the owner calls "today"). */
export function kyivToday(now: Date | number | string = new Date()): string {
  return dayIn(now, KYIV_TZ);
}

/** The window start: a valid `?from=` near today, else today. */
export function resolveFrom(raw: unknown, today: string): string {
  if (!isDay(raw)) return today;
  const gap = Math.abs(utc(raw).getTime() - utc(today).getTime()) / 86_400_000;
  return gap <= FROM_RANGE_DAYS ? raw : today;
}

/** "Thu, 29 Oct". */
export function dayLabel(day: string): string {
  const d = utc(day);
  return `${WEEKDAY[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}

/** The weekday and day number of a column head: "Thu", "29". */
export function dayParts(day: string): { wd: string; n: string } {
  const d = utc(day);
  return { wd: WEEKDAY[d.getUTCDay()], n: String(d.getUTCDate()) };
}

/** "29 Oct – 2 Nov". */
export function rangeLabel(days: readonly string[]): string {
  if (!days.length) return '';
  const f = (day: string) => { const d = utc(day); return `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`; };
  return days.length === 1 ? f(days[0]) : `${f(days[0])} – ${f(days[days.length - 1])}`;
}

/** The day a "New post" without a cell starts on: tomorrow. */
export function defaultComposeDay(today: string): string {
  return addDays(today, 1);
}

// ── the page's address ─────────────────────────────────────────────────────────

/** `/app/calendar?from=&compose=&channel=&day=&post=`: the window start and the composer drawer (new post, or edit of one). */
export interface CalendarSearch {
  from?: string;
  compose?: 'new' | 'edit';
  channel?: string;
  day?: string;
  post?: string;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** What the route keeps of a typed or stale address: a value that is not valid is dropped, never an error page. */
export function parseCalendarSearch(raw: Record<string, unknown>): CalendarSearch {
  const post = text(raw.post);
  const compose = raw.compose === 'new' ? 'new' : raw.compose === 'edit' && post ? 'edit' : undefined;
  return {
    from: isDay(raw.from) ? raw.from : undefined,
    compose,
    channel: compose === 'new' ? text(raw.channel) : undefined,
    day: compose === 'new' && isDay(raw.day) ? raw.day : undefined,
    post: compose === 'edit' ? post : undefined,
  };
}

// ── Kyiv instants (the composer) ───────────────────────────────────────────────

/** `day` + `HH:MM` on the Kyiv wall clock → the ISO instant the API wants. */
export function kyivInstant(day: string, time: string): string {
  const [h, m] = time.split(':').map(Number);
  return zonedToUtc(day, h, m, KYIV_TZ).toISOString();
}

/** An instant → its Kyiv day and `HH:MM` (empty strings for an empty or bad value). */
export function splitKyiv(iso: string | null | undefined): { day: string; time: string } {
  const t = iso ? new Date(iso) : null;
  if (!t || Number.isNaN(t.getTime())) return { day: '', time: '' };
  return { day: dayIn(t, KYIV_TZ), time: formatIn(t, KYIV_TZ) };
}

/** `day` + `HH:MM` on a zone's wall clock is not at least `leadMin` minutes away from `now`. */
export function isSoonerThan(day: string, time: string, tz: string, now: Date, leadMin: number): boolean {
  if (!isDay(day) || !isTime(time)) return false;
  const [h, m] = time.split(':').map(Number);
  return zonedToUtc(day, h, m, tz).getTime() < now.getTime() + leadMin * 60_000;
}

// ── agents and rows ────────────────────────────────────────────────────────────

/** An orchestrator of a Telegram channel: one row of the grid. */
export interface CalAgent {
  handle:     string;
  name:       string;
  emoji:      string | null;
  mode:       EditorMode;
  paused:     boolean;
  /** `@space` (the channel key, as the tracked channel has it). */
  channelKey: string;
  /** `telegram:@space`: the anchor resource of its schedule. */
  ref:        string;
}

const PREFIX = 'telegram:';

/** The rows of the grid: top-level orchestrators of a Telegram resource (the same set as `/api/schedule/upcoming`). */
export function calendarAgents(tree: readonly AgentNode[] | null | undefined): CalAgent[] {
  const out: CalAgent[] = [];
  for (const a of tree ?? []) {
    if (a.kind !== 'orchestrator' || a.scope !== 'resource' || !a.scopeId?.startsWith(PREFIX)) continue;
    out.push({
      handle: a.handle, name: a.name, emoji: a.emoji ?? null, mode: a.effectiveMode ?? a.mode, paused: !!a.paused,
      channelKey: a.scopeId.slice(PREFIX.length), ref: a.scopeId,
    });
  }
  return out;
}

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** The orchestrator of a tracked channel (matched on the channel key), if there is one. */
export function agentOfChannel(agents: readonly CalAgent[], channel: Pick<TrackedChannel, 'channelKey'> | null | undefined): CalAgent | null {
  return agents.find((a) => same(a.channelKey, channel?.channelKey)) ?? null;
}

// ── chips ──────────────────────────────────────────────────────────────────────

export type ChipKind = 'slot' | 'series' | 'pin' | 'reserved' | 'yours';
export type ChipTarget = { type: 'slot'; id: string } | { type: 'post'; id: string; pending: boolean };

/** One chip of a cell: what `StatusMark` draws (`mark`), the two text lines, and where a click goes. */
export interface CalChip {
  key:      string;
  kind:     ChipKind;
  mark:     MarkKind;
  /** A projection that will not be written: its series is paused or its agent is off. Drawn quiet, not amber. */
  muted:    boolean;
  /** The owner's post failed or its delivery is unconfirmed: drawn with a coloured edge. */
  alert:    'danger' | 'warning' | null;
  time:     string;
  title:    string;
  /** The line under the title ("Published", "Series · not planned", "Instagram · Planned", "Yours · scheduled"). */
  status:   string;
  /** The platform name when it is not Telegram. */
  platform: string | null;
  /** Tooltip and accessible name: every fact of the chip in one sentence. */
  tip:      string;
  target:   ChipTarget | null;
}

const PLATFORM_NAME: Record<string, string> = {
  telegram: 'Telegram', instagram: 'Instagram', facebook: 'Facebook', threads: 'Threads', tiktok: 'TikTok', youtube: 'YouTube',
};

/** `instagram:abc` → `instagram`. */
export const platformOfRef = (ref: string): string => ref.split(':')[0];

/** The mark of a slot. An older server sends no `error`; then a skipped series slot cannot be told from a deliberate skip, so it stays "skipped" (never an invented miss). */
export function markOfSlot(slot: Pick<ScheduleSlot, 'status' | 'seriesName' | 'scheduleRuleId'> & { error?: string | null }): MarkKind {
  if (slot.error === undefined && slot.status === 'skipped') return 'skipped';
  return slotMark({ status: slot.status, error: slot.error, seriesName: slot.seriesName, scheduleRuleId: slot.scheduleRuleId });
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Which open pause (if any) stops a projected series or pin: `series:<name>`, `rule:<id>` or `resource:<ref>`. */
export function pauseOf(e: Pick<Entry, 'kind' | 'series' | 'ruleId' | 'title'>, ref: string, open: readonly Pick<SeriesPause, 'key'>[]): Pick<SeriesPause, 'key'> | null {
  const keys = new Set<string>([`resource:${ref}`]);
  if (e.kind === 'series') keys.add(`series:${e.series ?? e.title}`);
  if (e.kind === 'pin' && e.ruleId) keys.add(`rule:${e.ruleId}`);
  return open.find((p) => keys.has(p.key)) ?? null;
}

interface ChipCtx {
  agent: CalAgent;
  today: string;
  open:  readonly Pick<SeriesPause, 'key'>[];
}

/** The chip of one schedule entry, or `null` for entries the calendar does not draw (blackouts, frequency rules, projections of past days). */
function entryChip(e: Entry, res: ScheduleResource, byId: Map<string, ScheduleSlot>, day: string, ctx: ChipCtx): CalChip | null {
  if (e.kind === 'blackout' || e.kind === 'frequency') return null;
  const slot = e.slotId ? byId.get(e.slotId) : undefined;
  const platform = platformOfRef(res.ref);
  const tag = platform === 'telegram' ? null : PLATFORM_NAME[platform] ?? platform;
  const zone = res.timezone && res.timezone !== KYIV_TZ ? ` (${zoneLabel(res.timezone)})` : '';
  const kind: ChipKind = e.kind === 'reserved' ? 'reserved' : e.kind === 'pin' ? 'pin' : e.kind === 'series' ? 'series' : 'slot';

  let mark: MarkKind;
  let label: string;
  let muted = false;
  let detail = '';
  if (slot) {
    mark = markOfSlot(slot);
    label = MARK_LABEL[mark];
    if (slot.topic && slot.topic !== e.title) detail = slot.topic;
    const why = skipReason(slot.error ?? null);
    if (why) detail = [detail, `${why.label}${why.detail ? `: ${why.detail}` : ''}`].filter(Boolean).join(' · ');
    if (kind === 'reserved') label = `${slot.promo ? 'Promo' : 'Reserved'} · ${lower(label)}`;
  } else {
    // A series instance or a pin the planner has not turned into a slot. Past days: the series may not have existed
    // then, so a bare projection there says nothing true; hide it.
    if (day < ctx.today) return null;
    const what = e.kind === 'pin' ? 'Pin' : 'Series';
    const paused = pauseOf(e, res.ref, ctx.open);
    const off = ctx.agent.mode === 'off' || ctx.agent.paused;
    if (paused || off) {
      mark = 'skipped';
      muted = true;
      label = `${what} · ${paused ? 'paused' : ctx.agent.paused ? 'agent paused' : 'agent off'}`;
      detail = paused ? 'The planner does not plan it until it is resumed.' : 'Nothing is planned while the agent is not running.';
    } else {
      mark = 'not_planned';
      label = `${what} · ${lower(MARK_LABEL.not_planned)}`;
      detail = 'The planner has not written this post yet.';
    }
  }
  const status = tag ? `${tag} · ${lower(label)}` : label;
  return {
    key: `${res.ref}:${e.key}`, kind, mark, muted, alert: null, time: e.time, title: e.title, status, platform: tag,
    tip: [`${e.time}${zone}`, e.title, status, detail].filter(Boolean).join(' · '),
    target: slot ? { type: 'slot', id: slot.id } : null,
  };
}

const KIND_RANK: Record<ChipKind, number> = { slot: 0, reserved: 1, series: 2, pin: 2, yours: 3 };

/** Chips of a cell in clock order; at the same minute a slot comes before a projection, and the owner's post last. */
export function sortChips(chips: CalChip[]): CalChip[] {
  return [...chips].sort((a, b) => a.time.localeCompare(b.time) || KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.title.localeCompare(b.title));
}

/** The chips of one agent on one day, over every resource it posts to (the Telegram channel first in a tie). */
export function agentChips(sc: ScheduleResponse, agent: CalAgent, day: string, today: string, open: readonly Pick<SeriesPause, 'key'>[] = []): CalChip[] {
  const byId = new Map(sc.slots.map((s) => [s.id, s]));
  const out: CalChip[] = [];
  for (const res of sc.resources) {
    for (const e of cellEntries(sc, res.ref, day)) {
      const c = entryChip(e, res, byId, day, { agent, today, open });
      if (c) out.push(c);
    }
  }
  return sortChips(out);
}

// ── the owner's posts ──────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** A Telegram-HTML post as one line of plain text (tags dropped, the common entities decoded). */
export function plainText(html: string | null | undefined): string {
  return (html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m]).trim();
}

const TITLE_MAX = 80;

/** The title of an owner post: its first line of text, else what it carries. */
export function postTitle(p: Pick<ScheduledPost, 'text' | 'mediaType'>): string {
  const first = plainText(p.text).split('\n').map((l) => l.trim()).find(Boolean);
  if (first) return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first;
  return p.mediaType === 'photo' ? 'Photo post' : p.mediaType === 'video' ? 'Video post' : 'Post without text';
}

/** The chip of an owner's post. */
export function postChip(p: ScheduledPost): CalChip {
  const { time } = splitKyiv(p.scheduledAt);
  const status = `Yours · ${lower(publicationLabel(p.status))}`;
  const title = postTitle(p);
  const alert = p.status === 'failed' ? 'danger' : p.status === 'unknown' ? 'warning' : null;
  return {
    key: `post:${p.id}`, kind: 'yours', mark: 'yours', muted: false, alert, time, title, status, platform: null,
    tip: [time, title, status, p.error].filter(Boolean).join(' · '),
    target: { type: 'post', id: p.id, pending: p.status === 'pending' },
  };
}

// ── rows ───────────────────────────────────────────────────────────────────────

export type RowState = 'ready' | 'loading' | 'error';

/** One row of the grid: an agent, or "Other channels". `cells[i]` is the chips of `days[i]`. */
export interface CalRow {
  key:        string;
  kind:       'agent' | 'other';
  name:       string;
  /** The line under the name: `@space` for an agent, "2 channels" for the other row. */
  sub:        string;
  handle:     string | null;
  emoji:      string | null;
  mode:       EditorMode | null;
  paused:     boolean;
  channelKey: string | null;
  /** The channel key a "+ Add" in this row preselects (the other row only when it has exactly one channel). */
  composeKey: string | null;
  state:      RowState;
  error:      string | null;
  cells:      CalChip[][];
}

export interface ScheduleState { data?: ScheduleResponse; error?: string | null; loading?: boolean }

export interface BuildInput {
  agents:    readonly CalAgent[];
  /** By agent handle; a handle that is missing is "not asked yet". */
  schedules: Readonly<Record<string, ScheduleState | undefined>>;
  /** Open series pauses by agent handle. */
  pauses:    Readonly<Record<string, readonly Pick<SeriesPause, 'key'>[] | undefined>>;
  channels:  readonly Pick<TrackedChannel, 'id' | 'channelKey' | 'title' | 'username' | 'isMine'>[];
  posts:     readonly ScheduledPost[];
  days:      readonly string[];
  today:     string;
}

/**
 * The grid's rows. One per orchestrator, then "Other channels" when the owner has a channel without an agent (or a post
 * lands on a channel nobody can resolve). Owner posts go to the row of their channel; canceled posts and posts outside
 * the window are left out.
 */
export function buildRows(i: BuildInput): CalRow[] {
  const slotOf = new Map(i.days.map((d, n) => [d, n] as const));
  const channelById = new Map(i.channels.map((c) => [c.id, c] as const));
  const rowOfPost = (p: ScheduledPost): string => {
    const agent = agentOfChannel(i.agents, channelById.get(p.channelId));
    return agent ? agent.handle : 'other';
  };

  const mine = new Map<string, ScheduledPost[]>();
  for (const p of i.posts) {
    if (p.status === 'canceled' || !slotOf.has(dayIn(p.scheduledAt, KYIV_TZ))) continue;
    const k = rowOfPost(p);
    mine.set(k, [...(mine.get(k) ?? []), p]);
  }
  const addMine = (key: string, cells: CalChip[][]) => {
    for (const p of mine.get(key) ?? []) cells[slotOf.get(dayIn(p.scheduledAt, KYIV_TZ))!].push(postChip(p));
    return cells.map(sortChips);
  };

  const rows: CalRow[] = i.agents.map((a) => {
    const st = i.schedules[a.handle];
    const cells: CalChip[][] = i.days.map((d) => (st?.data ? agentChips(st.data, a, d, i.today, i.pauses[a.handle] ?? []) : []));
    return {
      key: a.handle, kind: 'agent', name: a.name, sub: `@${a.handle}`, handle: a.handle, emoji: a.emoji, mode: a.mode, paused: a.paused,
      channelKey: a.channelKey, composeKey: a.channelKey,
      state: st?.data ? 'ready' : st?.error ? 'error' : st?.loading === false ? 'ready' : 'loading',
      error: st?.data ? null : st?.error ?? null,
      cells: addMine(a.handle, cells),
    };
  });

  const others = i.channels.filter((c) => c.isMine && !agentOfChannel(i.agents, c));
  if (others.length || mine.has('other')) {
    const keys = others.map((c) => c.channelKey).filter((k): k is string => !!k);
    rows.push({
      key: 'other', kind: 'other', name: 'Other channels',
      sub: others.length === 1 ? (others[0].channelKey ?? others[0].title ?? '1 channel') : `${others.length} channel${others.length === 1 ? '' : 's'} without an agent`,
      handle: null, emoji: null, mode: null, paused: false, channelKey: null,
      composeKey: others.length === 1 && keys.length === 1 ? keys[0] : null,
      state: 'ready', error: null,
      cells: addMine('other', i.days.map(() => [])),
    });
  }
  return rows;
}

/** Chips beyond this index sit behind "+N more" unless the cell is expanded. */
export function visibleChips(chips: readonly CalChip[], expanded: boolean, max: number = CELL_CHIPS): { shown: CalChip[]; hidden: number } {
  if (expanded || chips.length <= max) return { shown: [...chips], hidden: 0 };
  return { shown: chips.slice(0, max), hidden: chips.length - max };
}

/** The accessible name of a "+ Add" button. */
export function addLabel(row: Pick<CalRow, 'name'>, day: string): string {
  return `Add post to ${row.name} on ${dayLabel(day)}`;
}

// ── "Ask the agent": a one-off pin ─────────────────────────────────────────────

/** The brief of a pin is 10 to 600 characters (schedule-rules.ts). */
export const BRIEF_MIN = 10;
export const BRIEF_MAX = 600;

/** Why the agent cannot be asked for this channel (`null` = it can). */
export function askUnavailable(agent: Pick<CalAgent, 'handle' | 'mode' | 'paused'> | null, scheduleError?: string | null): string | null {
  if (!agent) return 'This channel has no agent. Write the post yourself.';
  if (agent.paused) return `@${agent.handle} is paused, so it would not write anything.`;
  if (agent.mode === 'off') return `@${agent.handle} is off. Switch it on to ask for a post.`;
  if (scheduleError) return `@${agent.handle} has no schedule to put the post on yet.`;
  return null;
}

/** The format of the asked-for post: text when the channel's card allows it, else the first format it allows. */
export function askFormat(formats: readonly string[] | null | undefined): string {
  return formats?.includes('text') ? 'text' : formats?.[0] ?? 'text';
}

/** The pin rule behind "Ask the agent": one post, on one day, at a time on the resource's clock. */
export function askRule(a: { ref: string; day: string; time: string; format: string; brief: string }): RuleInput {
  return {
    resource_ref: a.ref, kind: 'pin', days: null, at_local: a.time, format: a.format, brief: a.brief.trim(),
    valid_from: a.day, valid_until: a.day, note: 'Asked for from the Calendar',
  };
}

/** What happens to the brief, by the agent's mode (the sentence under the button). */
export function askHint(a: { mode: EditorMode; approval: boolean; time: string; zone: string; day: string }): string {
  const when = `${a.time} ${zoneLabel(a.zone)} on ${dayLabel(a.day)}`;
  if (a.approval) return `The agent writes it at ${when}. The draft lands in Inbox → To approve.`;
  if (a.mode === 'shadow') return `Shadow mode: the agent writes it at ${when} but nothing is published.`;
  return `The agent writes and publishes it at ${when}.`;
}

/** Problems with an asked-for post, in the order the form shows them (English). */
export function askProblems(a: { brief: string; day: string; time: string; tz: string; now: Date; unavailable: string | null }): { field: 'channel' | 'text' | 'time'; message: string }[] {
  const out: { field: 'channel' | 'text' | 'time'; message: string }[] = [];
  if (a.unavailable) out.push({ field: 'channel', message: a.unavailable });
  const n = a.brief.trim().length;
  if (n < BRIEF_MIN) out.push({ field: 'text', message: `Describe the topic in at least ${BRIEF_MIN} characters.` });
  else if (n > BRIEF_MAX) out.push({ field: 'text', message: `The brief is ${n} characters; ${BRIEF_MAX} is the most.` });
  if (!isDay(a.day) || !isTime(a.time)) out.push({ field: 'time', message: 'Pick a day and a time.' });
  else if (isSoonerThan(a.day, a.time, a.tz, a.now, ASK_LEAD_MIN)) out.push({ field: 'time', message: `Pick a time at least ${ASK_LEAD_MIN} minutes from now.` });
  return out;
}

/** The toast after a save: "Scheduled for @space · Thu, 29 Oct 12:00". */
export function savedText(verb: 'Scheduled' | 'Draft requested', channel: string, day: string, time: string): string {
  return `${verb} for ${channel} · ${dayLabel(day)} ${time}`;
}
