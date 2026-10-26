/**
 * Spec 069 FR-004 / A10 on fakes: the daily summary lists what repeats without the owner's reaction (the notes that
 * stopped ringing) in its own block, and `repeatingSubjects` applies the same rule the Inbox applies when it demotes a note.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repeatingSubjects, subjectLabelUk } from '../agents/note-runs';
import { OwnerReports, repeatingLines } from './owner-reports';

const DAY = 86_400_000;
const NOW = new Date('2026-10-22T18:00:00Z');
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

interface InboxRow { subject: string; title: string; severity: string; created_at: Date }

/** Answers the daily summary's queries and the two repeat queries. */
function pool(o: { inbox?: InboxRow[]; acted?: Array<{ subject: string; created_at: Date }>; inboxThrows?: boolean }) {
  return {
    async query(sql: string, _params: any[] = []) {
      if (/date_trunc\('day'/.test(sql)) return { rows: [{ from_at: '2026-10-21T21:00:00.000Z' }] };
      if (/s.status IN \('published'/.test(sql)) return { rows: [] };
      if (/status = 'awaiting_approval' GROUP BY/.test(sql)) return { rows: [] };
      if (/unnest\(\$1::text\[\]\)/.test(sql)) return { rows: [] };
      if (/FROM agent_inbox WHERE severity = 'info'/.test(sql)) return { rows: [{ n: 0 }] };
      if (/FROM agent_inbox\s+WHERE subject IS NOT NULL/.test(sql)) {
        if (o.inboxThrows) throw new Error('boom');
        return { rows: [...(o.inbox ?? [])].sort((a, b) => a.subject.localeCompare(b.subject) || b.created_at.getTime() - a.created_at.getTime()) };
      }
      if (/FROM owner_cards c JOIN agent_inbox/.test(sql)) return { rows: o.acted ?? [] };
      throw new Error(`unexpected: ${sql}`);
    },
  } as any;
}

const note = (subject: string, daysAgo: number, severity = 'action', title = 'Series or fixed slot missed on telegram:@x (2026-10-20)'): InboxRow =>
  ({ subject, title, severity, created_at: ago(daysAgo) });
const MISS = 'silent:telegram:@x:miss';
/** Three notes 3 days apart (the repeat rhythm), the newest one a day old. */
const RUN = [note(MISS, 1, 'info'), note(MISS, 4), note(MISS, 7)];

test('repeatingSubjects: a run of three or more that the owner did not react to, oldest first', async () => {
  const other = [note('silent:telegram:@y:critic', 0.5, 'info'), note('silent:telegram:@y:critic', 3.5), note('silent:telegram:@y:critic', 6.5), note('silent:telegram:@y:critic', 9.5)];
  const got = await repeatingSubjects(pool({ inbox: [...RUN, ...other] }), NOW, 3);
  assert.deepEqual(got.map((g) => [g.subject, g.count]), [['silent:telegram:@y:critic', 4], [MISS, 3]], 'oldest run first');
  assert.equal(got[1].since.getTime(), ago(7).getTime());
});

test('repeatingSubjects: two notes, a broken run, a critical newest note, an all-info run and a reacted-to run are not listed', async () => {
  const two = [note('a:two', 1), note('a:two', 4)];
  const broken = [note('a:broken', 1), note('a:broken', 2), note('a:broken', 10)]; // a gap over repeatDays + 1 ends the run: 2 notes
  const critical = [note('a:crit', 1, 'critical'), note('a:crit', 4), note('a:crit', 7)];
  const allInfo = [note('a:info', 1, 'info'), note('a:info', 4, 'info'), note('a:info', 7, 'info')];
  const acted = [note('a:acted', 1, 'info'), note('a:acted', 4), note('a:acted', 7)];
  const got = await repeatingSubjects(pool({
    inbox: [...two, ...broken, ...critical, ...allInfo, ...acted],
    acted: [{ subject: 'a:acted', created_at: ago(4) }],
  }), NOW, 3);
  assert.deepEqual(got, []);
  // A reaction from before the run began does not count for it.
  const old = await repeatingSubjects(pool({ inbox: [...RUN], acted: [{ subject: MISS, created_at: ago(20) }] }), NOW, 3);
  assert.equal(old.length, 1);
  // No inbox rows at all: no second query is needed and nothing is listed.
  assert.deepEqual(await repeatingSubjects(pool({}), NOW, 3), []);
});

test('the subject label is the owner\'s words for the known shapes, the title otherwise', () => {
  assert.equal(subjectLabelUk('silent:telegram:@x:miss', 't'), 'Не виходять серії чи пости на telegram:@x');
  assert.equal(subjectLabelUk('silent:telegram:@x:critic', 't'), 'Критик відхиляє пости на telegram:@x');
  assert.equal(subjectLabelUk('escalation:main:posts', 't'), 'Менеджер: поради не виконуються (@main, posts)');
  assert.equal(subjectLabelUk('connection:telegram:@x', 't'), 'Підключення telegram:@x');
  assert.equal(subjectLabelUk('other:thing', 'Something odd — still going, 6 days'), 'Something odd');
});

test('repeatingLines: a line per subject with the date it began and the count; at most eight, then "and N more"', () => {
  const since = ago(7);
  const lines = repeatingLines([{ subject: MISS, title: 't', since, count: 3 }, { subject: 'x:y', title: 'A <b>', since, count: 5 }]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^🔁 Не виходять серії чи пости на telegram:@x — з 15\.10, 3 рази$/);
  assert.match(lines[1], /A &lt;b&gt; — з 15\.10, 5 разів$/);
  const many = Array.from({ length: 11 }, (_, n) => ({ subject: `s:${n}`, title: `t${n}`, since, count: 3 }));
  const out = repeatingLines(many);
  assert.equal(out.length, 9);
  assert.equal(out[8], '… і ще 3');
});

function reports(p: any) {
  const env: Record<string, string> = { DASHBOARD_URL: 'https://dash.example' };
  return new OwnerReports({
    pool: p, repo: { async lastReports() { return { daily: null, weekly: null }; } } as any, env: (k) => env[k],
    budgets: async () => ({ rows: [] }), health: async () => null, waiting: async () => [], now: () => NOW,
  } as any);
}

test('the daily summary has the block "repeats without your reaction" only when something does', async () => {
  const withRun = await reports(pool({ inbox: RUN })).daily();
  assert.match(withRun.text, /<b>Повторюється без вашої реакції<\/b>\n🔁 Не виходять серії чи пости на telegram:@x — з 15\.10, 3 рази/);
  assert.ok(withRun.text.indexOf('Повторюється без вашої реакції') < withRun.text.indexOf("Здоров'я"), 'the block comes before the health lines');

  const quiet = await reports(pool({})).daily();
  assert.doesNotMatch(quiet.text, /Повторюється/);

  // The lookup failing must not take the whole summary down.
  const broken = await reports(pool({ inboxThrows: true })).daily();
  assert.doesNotMatch(broken.text, /Повторюється/);
  assert.match(broken.text, /Підсумок дня/);
});
