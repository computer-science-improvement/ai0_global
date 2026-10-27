import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditPost, AuditStory } from '../post/integrity/types';
import { timelineContexts } from '../post/integrity/registry';
import { storyEventCheck } from '../post/integrity/checks/story-event';
import { assessStory } from './story-match';
import {
  eventOfPost, eventsNotCovered, mergeEvent, recapNeeded, recapNeededBlock, storyEventOf, eventNote, eventRef, eventFromRow, eventToJson,
  type EventStory,
} from './story-event';
import { StoryContextService } from './story-service';
import { EventRecapWatch } from './event-watch';
import { withEvents, assembleQuality } from '../manager/quality-digest';

/** Spec 037 T3: announcement → recap on the golden set (Apple «Welcome Home», 13.10 16:00) and with a fake clock. */

const DIR = join(__dirname, '..', 'post', 'testing');
const fixture = JSON.parse(readFileSync(join(DIR, 'channel-logs-2026-10.json'), 'utf8')) as { posts: AuditPost[] };
const byId = new Map(fixture.posts.map((p) => [p.id, p]));
const CH = 'ai-shukaie-novyny-dev';
const A1 = byId.get(`${CH}:1105`)!; // 07.10 «Анонс очікують 13 жовтня»
const A3 = byId.get(`${CH}:1125`)!; // 11.10 «Welcome Home» 13 жовтня о 16:00 за Києвом
const A4 = byId.get(`${CH}:1126`)!; // 12.10 «у вівторок, 13 жовтня»
const TZ = 'Europe/Kyiv';
const EVENT = '2026-10-13T13:00:00.000Z'; // 13.10 16:00 Kyiv

/** A post as a spec builds it (`story`, `{}` = an original), or an export (`null`: no declared story). */
function post(id: string, at: string, text: string, story: AuditStory | null = {}, channel = CH): AuditPost {
  return { id, channel, publishedAt: at, timezone: TZ, text, links: [], buttons: [], hashtags: [], media: null, ...(story ? { story } : {}) };
}
const at = (p: AuditPost) => p.publishedAt;

// ── date forms ───────────────────────────────────────────────────────────────

test('event dates parse: «13 жовтня о 16:00 за Києвом», «13.10», «23 жовтня»; a deadline is no event', () => {
  const timed = eventOfPost(post('t', '2026-10-11T19:00:00+03:00', 'Apple проведе захід «Welcome Home» 13 жовтня о 16:00 за Києвом у Нью-Йорку.'))!;
  assert.equal(timed.at, EVENT);
  assert.equal(timed.allDay, false);
  assert.equal(timed.name, 'Welcome Home');
  assert.match(timed.text, /13 жовтня о 16:00 за Києвом/);

  const num = eventOfPost(post('n', '2026-10-10T12:00:00+03:00', 'Презентація нового хаба — 13.10, трансляція на сайті Apple.'))!;
  assert.equal(num.day, '2026-10-13');
  assert.equal(num.allDay, true);
  assert.equal(num.at, '2026-10-12T21:00:00.000Z'); // local midnight
  assert.equal(num.end, '2026-10-13T21:00:00.000Z');

  const game = eventOfPost(post('g', '2026-10-15T12:00:00+03:00', 'Call of Duty: Modern Warfare 4 вийде 23 жовтня на PC і консолях.'))!;
  assert.equal(game.day, '2026-10-23');
  assert.equal(game.allDay, true);

  assert.equal(eventOfPost(post('d', '2026-10-10T12:00:00+03:00', 'Роздача в Epic Games Store триває до 15 жовтня 17:00.')), null);
  assert.equal(eventOfPost(post('p', '2026-10-14T12:00:00+03:00', 'Apple показала хаб 13 жовтня: ціна 349 доларів.')), null, 'a past date');
  assert.equal(eventOfPost(post('x', '2026-10-10T12:00:00+03:00', 'Ціни зростуть 20 жовтня на 10 %.')), null, 'no event word');

  // The golden set: the Apple announcements and the release dates of the games.
  assert.equal(eventOfPost(A1)!.day, '2026-10-13');
  assert.equal(eventOfPost(A3)!.at, EVENT);
  assert.equal(eventOfPost(A4)!.day, '2026-10-13');
  assert.equal(eventOfPost(byId.get(`${CH}:1120`)!)!.day, '2026-10-12', 'Fitbit «Реліз очікується вже завтра, 12 жовтня»');
  assert.equal(eventOfPost(byId.get('birzha-ihor-dev:857')!)!.day, '2026-11-10', 'Warhammer Survivors PS5');
  assert.equal(eventOfPost(byId.get('birzha-ihor-dev:859')!)!.day, '2026-11-02', 'Phoenix Cyclops');
});

test('event_date_missing: a declared story.event_at needs its date (and time) in the text', () => {
  const run = (text: string, eventAt: string) => storyEventCheck.run(post('s', '2026-10-11T19:00:00+03:00', text, { eventAt }), { previous: [] }).map((f) => f.code);
  assert.deepEqual(run('Apple проведе захід «Welcome Home» 13 жовтня о 16:00 за Києвом.', '2026-10-13T16:00'), []);
  assert.deepEqual(run('Презентація хаба — 13.10.', '2026-10-13'), []);
  assert.deepEqual(run('CoD MW4 вийде 23 жовтня.', '2026-10-23'), []);
  assert.deepEqual(run('Apple скоро проведе захід «Welcome Home».', '2026-10-13T16:00'), ['event_date_missing']);
  assert.deepEqual(run('Apple проведе захід 13 жовтня о 18:00 за Києвом.', '2026-10-13T16:00'), ['event_date_missing'], 'another time');
  assert.deepEqual(run('Apple проведе захід 13 жовтня.', 'завтра'), ['event_date_missing'], 'not a date');
  assert.deepEqual(storyEventCheck.run(post('s', '2026-10-11T19:00:00+03:00', 'Без дати.'), { previous: [] }), [], 'no event_at, no check');
});

// ── before the event: one announcement + one reminder ────────────────────────

test('Apple case: the 3rd and the 4th announcement are blocked (story_repeat); the event is 13.10 16:00 «Welcome Home»', () => {
  const ev = storyEventOf([A1, A3, A4])!;
  assert.equal(ev.at, EVENT);
  assert.equal(ev.name, 'Welcome Home');
  const timeline = new Map(timelineContexts(fixture.posts.filter((p) => p.channel === A1.channel)).map((x) => [x.post.id, x]));
  for (const id of [A3.id, A4.id]) {
    const t = timeline.get(id)!;
    const a = assessStory(t.post, t.ctx);
    assert.equal(a.role, 'repeat', id);
    const err = a.findings.find((f) => f.code === 'story_repeat');
    assert.ok(err, id);
    assert.match(err!.message, /Welcome Home|уже анонсовано/, id);
  }
  // 1126 went out 25 h before the event: just outside the reminder window, even declared as one.
  const asReminder = { ...A4, story: { kind: 'reminder' as const } };
  const a = assessStory(asReminder, { previous: [A3, A1] });
  assert.equal(a.role, 'repeat');
  assert.match(a.findings.find((f) => f.code === 'story_repeat')!.message, /лише в останні 24 год/);
});

test('one reminder in the last 24 h (declared), a second one is a repeat; release day counts for an all-day event', () => {
  const ann = post('ann', '2026-10-11T19:00:00+03:00', A3.text, {});
  const rem = post('rem', '2026-10-12T18:00:00+03:00', 'Нагадуємо: Apple «Welcome Home» уже завтра, 13 жовтня, о 16:00 за Києвом. Покажуть хаб HomeView з екраном.', { kind: 'reminder' });
  const r1 = assessStory(rem, { previous: [ann] });
  assert.equal(r1.role, 'reminder');
  assert.deepEqual(r1.findings.filter((f) => f.level === 'error'), []);
  const rem2 = post('rem2', '2026-10-13T10:00:00+03:00', 'Сьогодні о 16:00 за Києвом Apple «Welcome Home» покаже хаб HomeView з екраном.', { kind: 'reminder' });
  const r2 = assessStory({ ...rem2, story: { kind: 'reminder', followupOf: 'ann' } }, { previous: [{ ...rem, story: { kind: 'reminder' } }, ann] });
  assert.equal(r2.role, 'repeat');
  assert.match(r2.findings[0].message, /нагадування про подію .* уже було/);

  // A plain (undeclared kind) second post before the event: story_repeat that names the event.
  const plain = post('plain', '2026-10-12T18:00:00+03:00', rem.text, {});
  const r3 = assessStory(plain, { previous: [ann] });
  assert.equal(r3.role, 'repeat');
  assert.match(r3.findings[0].message, /уже анонсовано/);

  // A game release day (all-day): the announcement on 15.10, a reminder on the release day itself.
  const g1 = post('g1', '2026-10-15T12:00:00+03:00', 'Call of Duty: Modern Warfare 4 вийде 23 жовтня на PC, PlayStation 5 і Xbox Series. Activision показала кампанію.');
  const g2 = post('g2', '2026-10-23T09:00:00+03:00', 'Call of Duty: Modern Warfare 4 вийде сьогодні, 23 жовтня, на PC, PlayStation 5 і Xbox Series. Activision показала кампанію.', { kind: 'reminder' });
  assert.equal(assessStory(g2, { previous: [g1] }).role, 'reminder');
});

test('after the event: a recap of an export adds facts (follow-up); a spec post must be declared as a follow-up', () => {
  const recap = post('recap', '2026-10-13T20:00:00+03:00',
    'Apple показала HomeView на заході «Welcome Home»: хаб з екраном 6 дюймів, чип A18, ціна 349 доларів. Продажі стартують 24 жовтня, разом із ним HomePod Mini 3 і Apple TV 5.', null);
  const a = assessStory(recap, { previous: [A4, A3, A1] });
  assert.equal(a.role, 'followup');
  assert.deepEqual(a.findings.filter((f) => f.level === 'error'), []);
  const undeclared = assessStory({ ...recap, story: {} }, { previous: [A4, A3, A1] });
  assert.equal(undeclared.role, 'repeat');
  assert.match(undeclared.findings[0].message, /уже відбулася/);
});

// ── recap needed in the planner context ──────────────────────────────────────

/** The Apple story as the registry holds it (the three announcements were published on the DEV channel). */
function appleStory(extra: EventStory['posts'] = []): EventStory {
  return {
    storyId: 'st-apple', key: 'apple-home-hub', title: 'Apple і LG разом роблять розумний дім', event: storyEventOf([A1, A3, A4])!,
    posts: [A1, A3, A4].map((p, i): EventStory['posts'][number] => ({ resourceRef: `telegram:${CH}`, role: i ? 'followup' : 'original', at: new Date(at(p)).toISOString(), lead: p.text.split('\n')[0], ref: `pp:${i + 1}` }))
      .concat(extra),
  };
}

test('Apple case: after 13.10 16:00 (+2 h) the planner context has "recap needed" ahead of the active stories', async () => {
  const stories = [appleStory()];
  const card = { channelKey: CH, timezone: TZ };
  const svc = new StoryContextService({
    activeStories: async () => [],
    recapItems: async (key, now) => recapNeeded(stories, `telegram:${key}`, now),
  });
  assert.equal(await svc.activeBlock(card, 'planner', new Date('2026-10-13T14:00:00Z')), null, '17:00 Kyiv: the event just ended');
  const block = (await svc.activeBlock(card, 'planner', new Date('2026-10-13T15:30:00Z')))!;
  assert.match(block, /recap needed/);
  assert.match(block, /«Welcome Home»/);
  assert.match(block, /13\.10\.2026 16:00/);
  assert.match(block, /анонсовано 3 раз\(и\)/);
  assert.match(block, /важливіший за звичайні записи фіду/);
  assert.match(block, /Apple і LG разом роблять розумний дім/, 'what the announcements showed');
  const exec = (await svc.activeBlock(card, 'executor', new Date('2026-10-13T15:30:00Z')))!;
  assert.match(exec, /followup_of: <оригінал>/);
  // A sibling channel never announced it: nothing to recap there.
  assert.equal(await svc.activeBlock({ channelKey: 'ai-tekhnolohii', timezone: TZ }, 'planner', new Date('2026-10-13T15:30:00Z')), null);
  // Covered by a post after the event: the item is gone; a reminder before it does not count.
  const covered = [appleStory([{ resourceRef: `telegram:${CH}`, role: 'followup', at: '2026-10-13T17:00:00.000Z', lead: 'Apple показала HomeView', ref: 'pp:9' }])];
  assert.deepEqual(recapNeeded(covered, `telegram:${CH}`, new Date('2026-10-13T18:00:00Z')), []);
  // Dropped 72 h after the event (stale).
  assert.deepEqual(recapNeeded(stories, `telegram:${CH}`, new Date('2026-10-16T14:00:00Z')), []);
  assert.equal(recapNeededBlock([], { timezone: TZ, role: 'planner' }), null);
});

// ── no recap within 24 h: one Inbox note per event (fake clock) ──────────────

function fakeInbox() {
  const items: Array<{ kind: string; refType: string; refId: string; title: string; body?: string | null }> = [];
  return {
    items,
    postOnce: async (i: { kind: string; refType: string; refId: string; title: string; body?: string | null }) => {
      if (items.some((x) => x.kind === i.kind && x.refType === i.refType && x.refId === i.refId)) return null;
      items.push(i);
      return items.length;
    },
  };
}

test('fake clock: no recap 24 h after the event → exactly one Inbox note per event', async () => {
  const fitbit = eventOfPost(byId.get(`${CH}:1120`)!)!; // all-day 12.10 → due 14.10 00:00 Kyiv
  const stories: EventStory[] = [
    appleStory(),
    { storyId: 'st-fitbit', key: 'fitbit-edge', title: 'Fitbit Edge', event: fitbit,
      posts: [{ resourceRef: `telegram:${CH}`, role: 'original', at: '2026-10-10T10:00:18.000Z', lead: 'Google опублікував на X фото Fitbit Edge', ref: 'pp:20' }] },
  ];
  const inbox = fakeInbox();
  const watch = new EventRecapWatch({ inbox, stories: async (from, to) => stories.filter((s) => Date.parse(s.event.at) >= from.getTime() && Date.parse(s.event.at) <= to.getTime()), tzOf: async () => TZ, everyMs: 0 });
  const tick = (iso: string) => watch.check(new Date(iso));

  assert.equal(await tick('2026-10-13T15:00:00Z'), 0, 'Fitbit not due yet (its day ended at 13.10 00:00 + 24 h)');
  assert.equal(await tick('2026-10-13T22:00:00Z'), 1, 'Fitbit: 24 h after its release day');
  assert.equal(await tick('2026-10-14T12:59:00Z'), 0, 'Apple: 23 h 59 min after the event');
  assert.equal(await tick('2026-10-14T13:00:00Z'), 1, 'Apple: 24 h after the event');
  for (const t of ['2026-10-14T13:05:00Z', '2026-10-14T20:00:00Z', '2026-10-15T09:00:00Z', '2026-10-15T23:00:00Z']) assert.equal(await tick(t), 0, `no repeat at ${t}`);
  assert.equal(inbox.items.length, 2);
  assert.deepEqual(inbox.items.map((i) => i.kind), ['event_not_covered', 'event_not_covered']);
  const apple = inbox.items.find((i) => i.refId.startsWith('st-apple'))!;
  assert.deepEqual({ refType: apple.refType, refId: apple.refId }, eventRef('st-apple', { at: EVENT }));
  assert.match(apple.title, /Announced event got no recap: «Welcome Home»/);
  assert.match(apple.body!, /announced 3 time\(s\)/);
  assert.match(apple.body!, /13\.10\.2026 16:00/);

  // A covered event never alerts; a long-gone one (restart after a pause) neither.
  const inbox2 = fakeInbox();
  const covered = [appleStory([{ resourceRef: `telegram:${CH}`, role: 'followup', at: '2026-10-14T08:00:00.000Z', lead: 'Apple показала HomeView', ref: 'pp:9' }])];
  const w2 = new EventRecapWatch({ inbox: inbox2, stories: async () => covered, tzOf: async () => TZ, everyMs: 0 });
  assert.equal(await w2.check(new Date('2026-10-14T14:00:00Z')), 0);
  const w3 = new EventRecapWatch({ inbox: inbox2, stories: async () => [appleStory()], tzOf: async () => TZ, everyMs: 0 });
  assert.equal(await w3.check(new Date('2026-10-20T14:00:00Z')), 0, 'more than 48 h after the 24 h ran out');
  assert.equal(inbox2.items.length, 0);
});

test('the throttle: one look per 5 minutes', async () => {
  const inbox = fakeInbox();
  let loads = 0;
  const watch = new EventRecapWatch({ inbox, stories: async () => { loads++; return [appleStory()]; }, tzOf: async () => TZ });
  await watch.check(new Date('2026-10-14T13:00:00Z'));
  await watch.check(new Date('2026-10-14T13:02:00Z'));
  await watch.check(new Date('2026-10-14T13:06:00Z'));
  assert.equal(loads, 2);
  assert.equal(inbox.items.length, 1);
});

// ── spec 069 A6: a note is closed when its event is no longer a gap ──────────

/** An Inbox with `markRead`: the unread `event_not_covered` notes are what `openNotes` lists. */
function readableInbox() {
  const base = fakeInbox();
  const notes: Array<{ id: number; refId: string; read: boolean }> = [];
  const marked: number[][] = [];
  return {
    ...base, notes, marked,
    postOnce: async (i: Parameters<typeof base.postOnce>[0]) => {
      const id = await base.postOnce(i);
      if (id != null) notes.push({ id, refId: i.refId, read: false });
      return id;
    },
    markRead: async (ids: number[]) => { marked.push(ids); for (const n of notes) if (ids.includes(n.id)) n.read = true; return ids.length; },
    openNotes: async () => notes.filter((n) => !n.read).map((n) => ({ id: n.id, refId: n.refId })),
  };
}

test('spec 069: a second identical check posts nothing, and the open note is marked read once a recap comes out', async () => {
  const inbox = readableInbox();
  let stories: EventStory[] = [appleStory()];
  const watch = new EventRecapWatch({ inbox, openNotes: inbox.openNotes, stories: async () => stories, tzOf: async () => TZ, everyMs: 0 });
  assert.equal(await watch.check(new Date('2026-10-14T13:05:00Z')), 1, 'the first note');
  assert.equal(await watch.check(new Date('2026-10-14T13:10:00Z')), 0, 'the second identical check posts nothing');
  assert.deepEqual(inbox.marked, [], 'the event is still a gap: the note stays open');
  assert.equal(inbox.notes[0].read, false);

  // A followup after the event: the gap is closed, so the note is read (and the owner-bot sweep closes its card).
  stories = [appleStory([{ resourceRef: `telegram:${CH}`, role: 'followup', at: '2026-10-14T14:00:00.000Z', lead: 'Apple показала HomeView', ref: 'pp:9' }])];
  assert.equal(await watch.check(new Date('2026-10-14T15:00:00Z')), 0);
  assert.deepEqual(inbox.marked, [[1]]);
  assert.equal(inbox.notes[0].read, true);
  // Nothing left to close on the next look.
  await watch.check(new Date('2026-10-14T15:10:00Z'));
  assert.equal(inbox.marked.length, 1);
});

test('spec 069: the note is marked read when the alert grace runs out with no recap', async () => {
  const inbox = readableInbox();
  const watch = new EventRecapWatch({ inbox, openNotes: inbox.openNotes, stories: async () => [appleStory()], tzOf: async () => TZ, everyMs: 0 });
  assert.equal(await watch.check(new Date('2026-10-15T09:00:00Z')), 1);
  assert.equal(await watch.check(new Date('2026-10-16T12:00:00Z')), 0, 'still inside 24 h + 48 h: the note stays');
  assert.deepEqual(inbox.marked, []);
  assert.equal(await watch.check(new Date('2026-10-16T14:00:00Z')), 0, 'the grace is over: no gap any more');
  assert.deepEqual(inbox.marked, [[1]]);
});

test('spec 069: notes of other events stay open, and an Inbox without markRead or a failing lookup changes nothing', async () => {
  const inbox = readableInbox();
  inbox.notes.push({ id: 90, refId: 'st-other|2026-10-14T10:00:00.000Z', read: false });
  const watch = new EventRecapWatch({ inbox, openNotes: inbox.openNotes, stories: async () => [appleStory()], tzOf: async () => TZ, everyMs: 0 });
  await watch.check(new Date('2026-10-14T13:05:00Z'));
  assert.deepEqual(inbox.marked, [[90]], 'only the note whose event is not an open gap is read');
  assert.equal(inbox.notes.find((n) => n.refId.startsWith('st-apple'))!.read, false);

  const plain = fakeInbox();
  const logs: string[] = [];
  await new EventRecapWatch({ inbox: plain, stories: async () => [appleStory()], tzOf: async () => TZ, everyMs: 0 }).check(new Date('2026-10-14T13:05:00Z'));
  assert.equal(plain.items.length, 1, 'no markRead: the note is posted as before');

  const broken = readableInbox();
  const w = new EventRecapWatch({ inbox: broken, openNotes: async () => { throw new Error('db down'); }, stories: async () => [appleStory()], tzOf: async () => TZ, everyMs: 0, log: (m) => logs.push(m) });
  assert.equal(await w.check(new Date('2026-10-14T13:05:00Z')), 1);
  assert.match(logs.join('\n'), /event notes not closed: db down/);
});

// ── the MANAGER digest ───────────────────────────────────────────────────────

test('MANAGER digest: event_not_covered flag and row per resource', () => {
  const gaps = eventsNotCovered([appleStory()], new Date('2026-10-15T08:00:00Z'), new Date('2026-10-08T08:00:00Z'));
  assert.equal(gaps.length, 1);
  assert.deepEqual(gaps[0].resources.map((r) => [r.ref, r.announced]), [[`telegram:${CH}`, 3]]);
  const q = assembleQuality({ critic: [], posts: [], owner: [], caps: { pollsPerWeek: 1, questionsPerDay: 0 } as any });
  const w = withEvents(q, gaps);
  assert.ok(w.flags.includes('event_not_covered'));
  assert.ok(w.signature.flags.includes('event_not_covered'), 'a new uncovered event changes the digest hash');
  assert.deepEqual(w.events_not_covered, [{ story_key: 'apple-home-hub', event: 'Welcome Home', at: EVENT, all_day: false, announced: 3 }]);
  assert.equal(withEvents(q, []), q);
  const note = eventNote(gaps[0], TZ);
  assert.doesNotMatch(note.title + note.body, /[а-яіїєґ]{4,}(?![^«]*»)/i, 'English copy (names in «» excepted)');
});

// ── the stored event ─────────────────────────────────────────────────────────

test('the stored event: set, refined with a time, moved before the start, never after it', () => {
  const day = eventOfPost(A1)!;
  const timed = eventOfPost(A3)!;
  assert.equal(mergeEvent(null, day), day);
  assert.equal(mergeEvent(day, timed, at(A3)), timed, 'a time for the same day');
  assert.equal(mergeEvent(timed, day, at(A4)), timed, 'an all-day mention does not undo the time');
  const moved = eventOfPost(post('m', '2026-10-12T10:00:00+03:00', 'Apple перенесла презентацію хаба на 20 жовтня о 17:00 за Києвом.'))!;
  assert.equal(mergeEvent(timed, moved, '2026-10-12T07:00:00Z'), moved, 'moved before the start');
  assert.equal(mergeEvent(timed, moved, '2026-10-13T14:00:00Z'), timed, 'after the start nothing moves');
  const back = eventFromRow(new Date(timed.at), eventToJson(timed))!;
  assert.deepEqual(back, timed);
  const allDay = eventFromRow(new Date(day.at), eventToJson(day))!;
  assert.deepEqual(allDay, day);
});
