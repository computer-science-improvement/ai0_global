/**
 * Spec 060 FR-003 against a throwaway Postgres: the repeat rule on real Inbox rows (a note fires again only on a new
 * cause or number, or once per OWNER_NOTE_REPEAT_DAYS as "still"), a newer note supersedes the older unread ones and
 * tells the card sink, the series_missed + dark_day merge, and the review-3 replay (ten daily notes about one dead
 * series become four). Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dailyRef, OwnerInbox, setInboxSupersedeSink } from './owner-inbox';
import { evaluateSilentDays, type WatchSlot } from '../silent/silent-days';
import { createMigratedDb, type FreshDb } from '../sysadmin/testing/fresh-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const MIGRATION = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'database', 'migrations', '093_series_pauses.sql'), 'utf8');
const P = 'pgt060n';
// Spec 069: its own throwaway database (init.sql + every migration) instead of the shared one; dropped in `after`.
let db: FreshDb;
let pool: FreshDb['pool'];
let inbox: OwnerInbox;
let superseded: number[][] = [];

const cleanup = async () => { await pool.query(`DELETE FROM agent_inbox WHERE subject LIKE '${P}:%' OR title LIKE '%${P}%'`); };
const rows = async (subject: string) => (await pool.query(
  `SELECT id::int, kind, title, parts, read_at IS NOT NULL AS read FROM agent_inbox WHERE subject = $1 ORDER BY id`, [subject])).rows as Array<{ id: number; kind: string; title: string; parts: string[]; read: boolean }>;
/** Time travel: the subject's notes are `days` older. */
const age = (subject: string, days: number) => pool.query(`UPDATE agent_inbox SET created_at = created_at - ($2 || ' days')::interval WHERE subject = $1`, [subject, String(days)]);

before(async () => {
  if (!url) return;
  db = await createMigratedDb(url, 'n060');
  pool = db.pool;
  await cleanup();
  inbox = new OwnerInbox(pool, async () => {});
  setInboxSupersedeSink(async (ids) => { superseded.push(ids); });
});
beforeEach(() => { superseded = []; });
after(async () => {
  if (!url) return;
  setInboxSupersedeSink(null);
  await db.drop();
});

const note = (subject: string, parts: string[], day: string, over: Record<string, unknown> = {}) => inbox.postOnce({
  kind: 'critic_reject_streak', severity: 'action', title: `${P} critic streak`, body: 'b', ...dailyRef(subject, day), gate: { subject, parts }, ...over,
});

test('093 applies again; a gated note is stored with its subject and parts', { skip }, async () => {
  await pool.query(MIGRATION);
  const s = `${P}:store`;
  const id = await note(s, ['streak:3'], '2026-10-01');
  assert.ok(id);
  assert.deepEqual((await rows(s)).map((r) => [r.kind, r.parts, r.read]), [['critic_reject_streak', ['streak:3'], false]]);
});

test('same cause and number: quiet the same day and the next days; a number that grew by a whole step fires and supersedes the older note', { skip }, async () => {
  const s = `${P}:streak`;
  const first = await note(s, ['streak:3'], '2026-10-01');
  assert.ok(first);
  assert.equal(await note(s, ['streak:3'], '2026-10-01'), null, 'same day');
  assert.equal(await note(s, ['streak:3'], '2026-10-02'), null, 'the next day: not every morning');
  assert.equal(await note(s, ['streak:4'], '2026-10-02'), null, 'one more is not news (spec 069: the step is 3)');
  assert.equal(superseded.length, 0);
  const second = await note(s, ['streak:6'], '2026-10-02');
  assert.ok(second && second !== first, 'a streak a whole step bigger is news');
  assert.deepEqual(superseded, [[first!]], 'the card sink hears which note was answered');
  assert.deepEqual((await rows(s)).map((r) => r.read), [true, false], 'one unread note per problem');
  assert.equal(await note(s, ['streak:6'], '2026-10-03'), null);
});

test('still going: after OWNER_NOTE_REPEAT_DAYS the note comes once more with its age', { skip }, async () => {
  const s = `${P}:still`;
  await note(s, ['streak:3'], '2026-10-01');
  await age(s, 4);
  const again = await note(s, ['streak:3'], '2026-10-05', { alert: { title: 'Критик відхилив 3', body: 'b' } });
  assert.ok(again);
  const r = await rows(s);
  assert.equal(r.length, 2);
  assert.match(r[1].title, /still going, 4 days/);
  assert.deepEqual(r.map((x) => x.read), [true, false]);
  // The Telegram wording is Ukrainian and says "досі".
  const sent: string[] = [];
  const talk = new OwnerInbox(pool, async (t) => { sent.push(t); });
  await age(s, 4);
  await talk.postOnce({ kind: 'critic_reject_streak', severity: 'action', title: `${P} critic streak`, ...dailyRef(s, '2026-10-09'), gate: { subject: s, parts: ['streak:3'] }, alert: { title: 'Критик відхилив 3', body: null } });
  assert.match(sent[0], /Критик відхилив 3 — досі, 8 днів/, 'counted from the first note of the unbroken run');
});

test('review-3 replay: a dead series that misses every day for ten days is four notes, not ten', { skip }, async () => {
  const s = `${P}:replay`;
  let fired = 0;
  for (let day = 0; day < 10; day++) {
    const d = `2026-10-${String(day + 1).padStart(2, '0')}`;
    if (await inbox.postOnce({ kind: 'series_missed', severity: 'action', title: `${P} series missed`, ...dailyRef(s, d), gate: { subject: s, parts: ['missed:Prompt:nothing_fresh'] } })) fired++;
    await age(s, 1);
  }
  assert.equal(fired, 4, 'day 1, then every third day (3 days old at day 4, 7 and 10)');
  assert.equal((await rows(s)).filter((r) => !r.read).length, 1);
});

test('series_missed at 09:00 and dark_day at 19:00 are one live note; the next day repeats nothing', { skip }, async () => {
  const REF = `telegram:@${P}`;
  const subject = `silent:${REF}:miss`;
  const miss: WatchSlot = {
    id: 's1', ref: REF, scheduledAt: new Date('2026-10-22T06:00:00Z'), updatedAt: new Date('2026-10-22T06:05:00Z'), status: 'skipped', error: 'no_fresh_item: x',
    format: 'text', topic: 'T', seriesName: 'Prompt', scheduleRuleId: null, criticVerdict: null, fallback: null,
  };
  const post = async (a: ReturnType<typeof evaluateSilentDays>[number]) => inbox.postOnce({
    agentId: null, kind: a.kind, severity: 'action', title: `${P} ${a.title}`, body: a.body, ...dailyRef(a.ref, a.day), alert: a.alert, gate: { subject: a.subject, parts: a.parts },
  });
  const res = [{ ref: REF, tz: 'Europe/Kyiv', minPerDay: 1 }];
  const morning = evaluateSilentDays({ now: new Date('2026-10-22T06:30:00Z'), resources: res, slots: [miss] });
  assert.deepEqual(morning.map((a) => a.kind), ['series_missed']);
  const first = await post(morning[0]);
  assert.ok(first);
  const evening = evaluateSilentDays({ now: new Date('2026-10-22T16:00:00Z'), resources: res, slots: [miss] });
  assert.deepEqual(evening.map((a) => a.kind), ['dark_day']);
  const second = await post(evening[0]);
  assert.ok(second);
  assert.deepEqual(superseded, [[first!]]);
  const r = await rows(subject);
  assert.deepEqual(r.map((x) => [x.kind, x.read]), [['series_missed', true], ['dark_day', false]]);
  // A later check of the same evening and the next morning: nothing new.
  assert.equal(await post(evening[0]), null);
  const nextDay = evaluateSilentDays({ now: new Date('2026-10-23T06:30:00Z'), resources: res, slots: [miss] });
  for (const a of nextDay) assert.equal(await post(a), null, `${a.kind} the next day says nothing new`);
});

test('a note without a gate behaves as before: once per ref, no memory, nothing superseded', { skip }, async () => {
  const ref = dailyRef(`${P}:plain`, '2026-10-01');
  assert.ok(await inbox.postOnce({ kind: 'dark_day', title: `${P} plain`, ...ref }));
  assert.equal(await inbox.postOnce({ kind: 'dark_day', title: `${P} plain`, ...ref }), null);
  assert.ok(await inbox.postOnce({ kind: 'dark_day', title: `${P} plain`, ...dailyRef(`${P}:plain`, '2026-10-02') }), 'another day is another note');
  assert.deepEqual(superseded, []);
});
