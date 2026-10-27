/**
 * Spec 069 FR-005 on fakes: the manager escalates by code (two triggers, one gated Inbox note and one memory line each), the
 * digest lists the open escalations and counts them in its hash and review signature, `countsAsCover` ignores advice nobody
 * followed, `submit_review` refuses a review that leaves an escalation unanswered, and the default time is a single 09:00.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OwnerInbox } from '../agents/owner-inbox';
import {
  ESCALATION_ANSWERS_MAX, ESCALATION_POSTS_LOOKBACK_DAYS, escalationKeys, escalationSubject, notFollowedNote, openEscalations,
  parseEscalationSubject, postsNote, postsRuns, type DigestEscalation, type NotFollowedGroup, type PostsDay,
} from './escalation';
import { dayBefore } from './kpi-math';
import { buildDirectiveTools, checkEscalations, SubmitReviewInput } from './directive-tools';
import { countsAsCover, digestHash, digestView, reviewSignature, type KpiDigest } from './kpi-digest.service';
import { DEFAULT_MANAGER_TIMES, ManagerRunner, managerSystemPrompt, openDirectivesText } from './manager-runner';

const DAY = 86_400_000;
const NOW = new Date('2026-10-26T07:30:00Z'); // 09:30 Kyiv (UTC+2 after 25.10), 2026-10-26
const TODAY = '2026-10-26';

// ── an in-memory Inbox table behind the real OwnerInbox (the gate is the real one) ──

interface Row { id: number; kind: string; title: string; ref_type: string; ref_id: string; severity: string; subject: string; parts: string[]; created_at: Date; read_at: Date | null; agent_id: string | null }

function memPool() {
  const rows: Row[] = [];
  const pool = {
    rows,
    async query(text: string, params: any[] = []) {
      if (/SELECT parts, created_at FROM agent_inbox/.test(text)) {
        return { rows: rows.filter((r) => r.subject === params[0]).sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || b.id - a.id).map((r) => ({ parts: r.parts, created_at: r.created_at })) };
      }
      if (/INSERT INTO agent_inbox/.test(text)) {
        const [agent_id, kind, title, , ref_type, ref_id, severity, subject, parts] = params;
        if (rows.some((r) => r.kind === kind && r.ref_type === ref_type && r.ref_id === ref_id)) return { rows: [] };
        const row: Row = { id: rows.length + 1, kind, title, ref_type, ref_id, severity, subject, parts: parts ?? [], created_at: new Date(), read_at: null, agent_id };
        rows.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (/UPDATE agent_inbox SET read_at = now\(\) WHERE subject/.test(text)) {
        const hit = rows.filter((r) => r.subject === params[0] && r.id !== params[1] && !r.read_at);
        for (const r of hit) r.read_at = new Date();
        return { rows: hit.map((r) => ({ id: r.id })) };
      }
      if (/UPDATE agent_inbox SET actions/.test(text)) return { rows: [] };
      if (/FROM owner_cards c JOIN agent_inbox/.test(text)) return { rows: [] };
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
  /** Time travel: every stored note is `days` older. */
  const age = (days: number) => { for (const r of rows) r.created_at = new Date(r.created_at.getTime() - days * DAY); };
  return { pool, rows, age };
}

const group = (ids: string[], over: Partial<NotFollowedGroup> = {}): NotFollowedGroup => ({
  agentId: 'a1', handle: 'ai_global', kind: 'voice_fix', ids, bodies: ids.map((_, i) => `Прибрати штампи з постів, правило ${i + 1}`), ...over,
});
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

function setup(o: { groups?: NotFollowedGroup[]; days?: PostsDay[]; filed?: number } = {}) {
  const mem = memPool();
  const alerts: string[] = [];
  const clock = { now: NOW };
  const state = {
    groups: o.groups ?? [], days: o.days ?? [], filed: o.filed ?? 0, memory: [] as any[],
    /** The `fromDay` of every posts query and the `since` of every filedSince call. */
    fromDays: [] as string[], filedSince: [] as Date[],
  };
  const repo = {
    notFollowedGroups: async () => state.groups,
    negativePostsDays: async (from: string) => { state.fromDays.push(from); return state.days.filter((d) => d.day >= from); },
    filedSince: async (_agentId: string, since: Date) => { state.filedSince.push(since); return state.filed; },
    addMemory: async (...a: any[]) => { state.memory.push(a); },
    /** The real one deactivates the system line of the subject; `state.memory` holds the active lines. */
    retireEscalationMemory: async (_agentId: string, subject: string) => {
      const before = state.memory.length;
      state.memory = state.memory.filter((a) => a[3]?.escalation !== subject);
      return before - state.memory.length;
    },
    /** The open definition over the in-memory table: the newest unread manager_escalation note per subject. */
    openEscalations: async () => {
      const newest = new Map<string, Row>();
      for (const r of [...mem.rows].sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id - b.id)) {
        if (r.kind === 'manager_escalation') newest.set(r.subject, r);
      }
      return [...newest.values()].filter((r) => !r.read_at).map((r) => {
        const kind = parseEscalationSubject(r.subject)!.kind;
        const days = r.parts.map((p) => /^days:(\d+)$/.exec(p)).find(Boolean);
        return { subject: r.subject, directive_ids: kind === 'posts' ? [] : r.parts, days: days ? Number(days[1]) : null };
      });
    },
  };
  const runner = new ManagerRunner({
    loop: { run: async () => ({}) as any }, registry: { forRole: () => [] }, runtime: { forAgent: async () => ({}) as any },
    agents: { findTop: async () => ({ id: 'm1', handle: 'manager', mode: 'live' }) as any, get: async () => null, list: async () => [] } as any,
    repo: repo as any, digest: { build: async () => ({}) as any, render: () => '{}', snapshot: async () => 1 },
    inbox: new OwnerInbox(mem.pool as any, async (t) => { alerts.push(t); }), env: () => undefined, now: () => clock.now,
  });
  return { runner, mem, state, alerts, clock };
}

// ── trigger 1 ──────────────────────────────────────────────────────────────

test('two pieces of advice nobody followed give one escalation note and one memory line; the gate stops a repeat', async () => {
  const t = setup({ groups: [group([A, B])] });
  assert.equal(await t.runner.escalate(), 1);
  const note = t.mem.rows[0];
  assert.equal(note.kind, 'manager_escalation');
  assert.equal(note.severity, 'action');
  assert.equal(note.ref_type, 'escalation', 'never directive / playbook: those would be swallowed by the item\'s own card');
  assert.equal(note.subject, 'escalation:ai_global:voice_fix');
  assert.deepEqual(note.parts, [A, B]);
  assert.equal(note.agent_id, 'a1');
  assert.match(note.title, /^Manager escalation: @ai_global did not follow 2 voice_fix items in 14 days$/);
  assert.doesNotMatch(note.title, /[а-яіїєґ]/i, 'English title');
  assert.match(t.alerts[0], /Менеджер: @ai_global не виконує поради \(voice_fix, 2 за 14 днів\)/, 'Ukrainian alert');
  assert.equal(t.state.memory.length, 1);
  const [agentId, kind, text, evidence, by] = t.state.memory[0];
  assert.deepEqual([agentId, kind, by], ['m1', 'avoid', 'system']);
  assert.match(text, /@ai_global не виконав 2 поради voice_fix за 14 днів \(id 11111111, 22222222\)/);
  assert.deepEqual(evidence, { escalation: 'escalation:ai_global:voice_fix', directives: [A, B] });

  // The hourly housekeeping looks again and finds the same two: nothing new.
  assert.equal(await t.runner.escalate(), 0);
  assert.equal(t.mem.rows.length, 1);
  assert.equal(t.state.memory.length, 1, 'no second memory line');

  // A third piece of advice that was not followed is news: the older note is read, the new one fires.
  t.state.groups = [group([A, B, C])];
  assert.equal(await t.runner.escalate(), 1);
  assert.equal(t.mem.rows.length, 2);
  assert.deepEqual(t.mem.rows.map((r) => !!r.read_at), [true, false], 'one unread note per problem');
});

test('one advice is not an escalation; another agent or kind is another escalation', async () => {
  const t = setup({ groups: [group([A, B]), group([C, A], { agentId: 'a2', handle: 'ai_recipes', kind: 'format_mix' })] });
  assert.equal(await t.runner.escalate(), 2);
  assert.deepEqual(t.mem.rows.map((r) => r.subject).sort(), ['escalation:ai_global:voice_fix', 'escalation:ai_recipes:format_mix']);
  assert.equal(await setup({ groups: [] }).runner.escalate(), 0);
});

test('without postOnce on the inbox (old wiring) escalate does nothing', async () => {
  const r = new ManagerRunner({
    loop: { run: async () => ({}) as any }, registry: { forRole: () => [] }, runtime: { forAgent: async () => ({}) as any },
    agents: { findTop: async () => null, get: async () => null, list: async () => [] } as any,
    repo: {} as any, digest: { build: async () => ({}) as any, render: () => '{}', snapshot: async () => 1 }, inbox: { post: async () => 1 }, env: () => undefined,
  });
  assert.equal(await r.escalate(), 0);
});

// ── trigger 2 ──────────────────────────────────────────────────────────────

const negative = (...days: string[]): PostsDay[] => days.map((day) => ({ agentId: 'a1', handle: 'ai_global', ref: 'telegram:@ai_global', day }));

test('postsRuns: three consecutive negative days up to yesterday or today; a gap, an old streak or two days are not a run', () => {
  assert.deepEqual(postsRuns(negative('2026-10-23', '2026-10-24', '2026-10-25'), TODAY).map((r) => [r.firstDay, r.days]), [['2026-10-23', 3]]);
  assert.deepEqual(postsRuns(negative('2026-10-24', '2026-10-25', '2026-10-26'), TODAY).map((r) => [r.firstDay, r.days]), [['2026-10-24', 3]], 'today\'s snapshot counts');
  assert.deepEqual(postsRuns(negative('2026-10-20', '2026-10-21', '2026-10-22', '2026-10-24', '2026-10-25'), TODAY), [], 'a gap breaks it: the live streak is two days');
  assert.deepEqual(postsRuns(negative('2026-10-20', '2026-10-21', '2026-10-22'), TODAY), [], 'the streak ended before yesterday');
  assert.deepEqual(postsRuns(negative('2026-10-24', '2026-10-25'), TODAY), []);
  assert.equal(postsRuns(negative('2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'), TODAY)[0].days, 5);
  // The longest streak among an agent's resources wins; duplicates of a day do not count twice.
  const two = [...negative('2026-10-23', '2026-10-24', '2026-10-25'), ...negative('2026-10-25', '2026-10-25'), { agentId: 'a1', handle: 'ai_global', ref: 'instagram:1', day: '2026-10-25' }];
  assert.equal(postsRuns(two, TODAY).length, 1);
});

test('three negative days with no directive filed give one note; the run growing a day or two says nothing, three more days repeat it', async () => {
  const t = setup({ days: negative('2026-10-23', '2026-10-24', '2026-10-25') });
  assert.equal(await t.runner.escalate(), 1);
  const note = t.mem.rows[0];
  assert.equal(note.subject, 'escalation:ai_global:posts');
  assert.deepEqual(note.parts, ['posts_from:2026-10-23', 'days:3']);
  assert.match(note.title, /^Manager escalation: posts of telegram:@ai_global below the norm for 3 days, no directive filed$/);
  assert.match(t.alerts[0], /постів на telegram:@ai_global менше за норму 3 дні поспіль/);
  assert.match(t.state.memory[0][2], /нижча за норму 3 дні поспіль \(з 2026-10-23\)/);

  t.state.days = negative('2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26');
  assert.equal(await t.runner.escalate(), 0, 'one more day is not news (step 3)');
  t.state.days = negative('2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27');
  assert.equal(await t.runner.escalate(), 0);
  t.state.days = negative('2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28');
  assert.equal(await t.runner.escalate(), 1, 'three more days: the problem is still there');
  assert.equal(t.mem.rows.length, 2);
  assert.equal(t.state.memory.length, 1, 'one memory line per escalation: the new one replaced the old');
  assert.match(t.state.memory[0][2], /нижча за норму 6 днів поспіль \(з 2026-10-23\)/);
});

test('a posts run longer than the old 10-day window keeps its true first day: it fires on the 3-day step, never once a day', async () => {
  const START = '2026-10-12';
  const t = setup();
  const fired: Array<[string, number, string]> = [];
  for (let d = 15; d <= 27; d++) {
    const today = `2026-10-${d}`;
    t.clock.now = new Date(`${today}T07:30:00Z`);
    // Every day from START up to yesterday is a negative day; the repo honours the lookback it is asked for.
    const upTo = d - 1;
    t.state.days = negative(...Array.from({ length: upTo - 12 + 1 }, (_, i) => `2026-10-${12 + i}`));
    const before = t.mem.rows.length;
    await t.runner.escalate();
    for (const r of t.mem.rows.slice(before)) fired.push([today, Number(r.parts.find((p) => p.startsWith('days:'))!.slice(5)), r.parts[0]]);
  }
  // The run is 3, 6, 9, 12 and 15 days long on those days: a note on each step of three, all with the same first day.
  assert.deepEqual(fired.map((f) => f[1]), [3, 6, 9, 12, 15]);
  assert.ok(fired.every((f) => f[2] === `posts_from:${START}`), 'posts_from is the real start of the run');
  assert.equal(t.mem.rows.length, 5);
  assert.equal(t.state.memory.length, 1, 'and one memory line');
  // The snapshots are read far enough back for any run (the baseline ends one after ~35 days), not 10 days.
  assert.ok(ESCALATION_POSTS_LOOKBACK_DAYS >= 35);
  assert.equal(t.state.fromDays[0], dayBefore('2026-10-15', ESCALATION_POSTS_LOOKBACK_DAYS));
});

test('"no directive filed" is judged from the true first day of a long run, not from a truncated one', async () => {
  const t = setup({ days: negative(...Array.from({ length: 14 }, (_, i) => `2026-10-${String(12 + i).padStart(2, '0')}`)) });
  t.clock.now = new Date('2026-10-26T07:30:00Z');
  await t.runner.escalate();
  assert.equal(t.state.filedSince.length, 1);
  // 2026-10-12 00:00 Kyiv (UTC+3 before 25.10) is 2026-10-11T21:00Z.
  assert.equal(t.state.filedSince[0].toISOString(), '2026-10-11T21:00:00.000Z');
});

test('an unread escalation is not posted again as «still going» after the repeat window, and its memory line is not written again', async () => {
  const t = setup({ groups: [group([A, B])] });
  assert.equal(await t.runner.escalate(), 1);
  // Four days on (past OWNER_NOTE_REPEAT_DAYS, inside the 14 days of an open escalation), nobody has read it.
  t.mem.age(4);
  t.clock.now = new Date(NOW.getTime() + 4 * DAY);
  assert.equal(await t.runner.escalate(), 0, 'it is open and says the same thing: the manager answers it in its reviews');
  assert.equal(t.mem.rows.length, 1);
  assert.equal(t.state.memory.length, 1);
  assert.equal(t.alerts.length, 1);

  // Once it is read it is closed; a cause that still goes on is told again as «still going», and the memory line is replaced, not doubled.
  t.mem.rows[0].read_at = new Date();
  assert.equal(await t.runner.escalate(), 1);
  assert.equal(t.mem.rows.length, 2);
  assert.match(t.mem.rows[1].title, /still going, 4 days$/);
  assert.equal(t.state.memory.length, 1, 'one line per subject');

  // A changed cause (a third piece of advice nobody followed) goes through while the older one is open, and replaces its line.
  t.state.groups = [group([A, B, C])];
  assert.equal(await t.runner.escalate(), 1);
  assert.equal(t.state.memory.length, 1);
  assert.match(t.state.memory[0][2], /не виконав 3 поради voice_fix/);
});

test('memory lines of different subjects do not replace each other', async () => {
  const t = setup({ groups: [group([A, B]), group([C, A], { agentId: 'a2', handle: 'ai_recipes', kind: 'format_mix' })] });
  assert.equal(await t.runner.escalate(), 2);
  t.state.groups = [group([A, B, C]), group([C, A], { agentId: 'a2', handle: 'ai_recipes', kind: 'format_mix' })];
  assert.equal(await t.runner.escalate(), 1);
  assert.equal(t.state.memory.length, 2);
});

test('a directive filed for the agent in that span stops trigger 2', async () => {
  const t = setup({ days: negative('2026-10-23', '2026-10-24', '2026-10-25'), filed: 1 });
  assert.equal(await t.runner.escalate(), 0);
  assert.equal(t.mem.rows.length, 0);
});

// ── notes and subjects ─────────────────────────────────────────────────────

test('subjects round-trip, and the note builders keep the gate parts the spec names', () => {
  assert.equal(escalationSubject('ai_global', 'posts'), 'escalation:ai_global:posts');
  assert.deepEqual(parseEscalationSubject('escalation:ai_global:voice_fix'), { handle: 'ai_global', kind: 'voice_fix' });
  assert.equal(parseEscalationSubject('silent:telegram:@x:miss'), null);
  const n = notFollowedNote(group([B, A]), TODAY);
  assert.deepEqual(n.item.gate?.parts, [A, B], 'sorted ids');
  assert.equal(n.item.refId, 'escalation:ai_global:voice_fix|2026-10-26');
  const p = postsNote({ agentId: 'a1', handle: 'ai_global', ref: 'telegram:@ai_global', firstDay: '2026-10-23', days: 3 }, TODAY);
  assert.deepEqual(p.item.gate, { subject: 'escalation:ai_global:posts', parts: ['posts_from:2026-10-23', 'days:3'], grow: { days: 3 } });
});

// ── the digest ─────────────────────────────────────────────────────────────

test('openEscalations: the newest unread manager_escalation note per subject of the last 14 days, in a stable order', async () => {
  const calls: any[][] = [];
  const pool = {
    async query(sql: string, params: any[]) {
      calls.push([sql, params]);
      return { rows: [
        { subject: 'escalation:ai_global:posts', parts: ['posts_from:2026-10-23', 'days:3'], title: 'Manager escalation: posts of telegram:@x below the norm for 3 days', created_at: new Date('2026-10-26T01:00:00Z') },
        { subject: 'escalation:ai_global:voice_fix', parts: [A, B], title: 'Manager escalation: @ai_global did not follow 2 voice_fix items in 14 days', created_at: new Date('2026-10-25T01:00:00Z') },
        { subject: 'silent:telegram:@x:miss', parts: ['x'], title: 'not an escalation subject', created_at: new Date('2026-10-25T01:00:00Z') },
      ] };
    },
  } as any;
  const list = await openEscalations(pool, NOW);
  assert.deepEqual(list.map((e) => [e.subject, e.agent, e.kind, e.directive_ids.length, e.days]), [
    ['escalation:ai_global:posts', 'ai_global', 'posts', 0, 3],
    ['escalation:ai_global:voice_fix', 'ai_global', 'voice_fix', 2, null],
  ]);
  assert.match(calls[0][0], /kind = \$1 AND read_at IS NULL/);
  assert.equal(calls[0][1][0], 'manager_escalation');
  assert.equal(Math.round((NOW.getTime() - calls[0][1][1].getTime()) / DAY), 14);
});

const baseDigest = (over: Partial<KpiDigest> = {}) => ({ resources: [], directives: { open: [], outcomes: [] }, ...over }) as Pick<KpiDigest, 'resources' | 'directives'> & { escalations?: DigestEscalation[] };
const esc = (over: Partial<DigestEscalation> = {}): DigestEscalation => ({
  subject: 'escalation:ai_global:voice_fix', agent: 'ai_global', kind: 'voice_fix', since: '2026-10-25', directive_ids: [A, B], days: null, text: 'Manager escalation: @ai_global did not follow 2 voice_fix items in 14 days', ...over,
});

test('the digest hash and the review signature change with a new escalation and with nothing else; with none they are what they were', () => {
  const none = baseDigest();
  assert.equal(digestHash(none), digestHash({ ...none, escalations: [] }), 'no escalations: the old hash');
  assert.equal(reviewSignature(none), reviewSignature({ ...none, escalations: [] }));
  const one = baseDigest({ escalations: [esc()] });
  assert.notEqual(digestHash(one), digestHash(none));
  assert.notEqual(reviewSignature(one), reviewSignature(none), 'an escalation forces a look');
  assert.equal(digestHash(one), digestHash(baseDigest({ escalations: [esc()] })), 'stable');
  const two = baseDigest({ escalations: [esc(), esc({ subject: 'escalation:ai_global:posts', kind: 'posts', directive_ids: [], days: 3 })] });
  assert.notEqual(digestHash(two), digestHash(one));
  assert.equal(digestHash(two), digestHash(baseDigest({ escalations: [...two.escalations!].reverse() })), 'the order does not matter');
  // A longer list of directives behind the same subject (a newer note) is a change too.
  assert.notEqual(digestHash(baseDigest({ escalations: [esc({ directive_ids: [A, B, C] })] })), digestHash(one));
  assert.deepEqual(escalationKeys(undefined), []);
});

test('the rendered digest carries the escalations block', () => {
  const dg = { generatedAt: NOW.toISOString(), today: TODAY, resources: [], agents: [], budget: { spentTodayUsd: 0, capUsd: 3 }, directives: { open: [], outcomes: [] }, hash: 'h', raw: new Map(), escalations: [esc()] } as unknown as KpiDigest;
  const parsed = JSON.parse(digestView(dg).text);
  assert.equal(parsed.escalations[0].subject, 'escalation:ai_global:voice_fix');
  assert.deepEqual(parsed.escalations[0].directive_ids, [A, B]);
  assert.equal('escalations' in JSON.parse(digestView({ ...dg, escalations: undefined } as KpiDigest).text), false);
});

test('countsAsCover: advice nobody followed covers nothing, whatever its status; the prompt marks an evaluated row for escalation', () => {
  const now = NOW.getTime();
  assert.equal(countsAsCover({ status: 'applied', adherence: 'not_followed', reviewAt: null }, now), false);
  assert.equal(countsAsCover({ status: 'evaluated', adherence: 'not_followed', reviewAt: null }, now), false);
  assert.equal(countsAsCover({ status: 'accepted', adherence: 'not_followed', reviewAt: null }, now), false);
  assert.equal(countsAsCover({ status: 'applied', adherence: 'followed', reviewAt: null }, now), true);
  assert.equal(countsAsCover({ status: 'accepted', adherence: null, reviewAt: new Date(now + DAY).toISOString() }, now), true);

  const text = openDirectivesText([
    { id: 'd1', to: 'ai_global', kind: 'voice_fix', status: 'evaluated', body: 'b', createdAt: '2026-10-20T00:00:00Z', adherence: 'not_followed', ageDays: 6 },
    { id: 'd2', to: 'ai_global', kind: 'format_mix', status: 'applied', body: 'b', createdAt: '2026-10-20T00:00:00Z', adherence: 'not_followed', ageDays: 6 },
  ]);
  const [evaluated, applied] = text.split('\n');
  assert.match(evaluated, /не виконано — ескалюй, не дублюй як пораду/);
  assert.doesNotMatch(applied, /ескалюй, не дублюй/);
  const sys = managerSystemPrompt({ agent: { name: 'Manager', handle: 'manager' } as any, now: NOW, digest: '{}', memory: '', skills: { inline: '', listed: '' } });
  assert.match(sys, /submit_review\.escalations/);
});

// ── submit_review ──────────────────────────────────────────────────────────

const deps = (dir: { toAgentId: string } | null = { toAgentId: 'a1' }) => ({
  repo: { get: async () => (dir ? { id: A, ...dir } : null) } as any,
  agents: { getByHandle: async (h: string) => (h === 'ai_global' ? { id: 'a1', handle: h } : null), findTop: async () => null } as any,
});
const open = { escalations: [esc()] };
const LONG = 'Порада вже відкрита з учора, чекаємо відповіді власника';

test('checkEscalations: an open escalation needs a directive filed in this review for that agent, or a reason of 20+ characters', async () => {
  const none = await checkEscalations(deps(), { escalations: [] }, { directive_ids: [], escalations: [] });
  assert.equal(none, null, 'nothing open: nothing to answer');
  const unaddressed = await checkEscalations(deps(), open, { directive_ids: [], escalations: [] });
  assert.equal(unaddressed?.error, 'escalation_unaddressed');
  assert.match(unaddressed!.details, /escalation:ai_global:voice_fix/);
  assert.equal((await checkEscalations(deps(), open, { directive_ids: [], escalations: [{ subject: esc().subject, decline_reason: 'не треба' }] }))?.error, 'escalation_reason_required');
  assert.equal(await checkEscalations(deps(), open, { directive_ids: [], escalations: [{ subject: esc().subject, decline_reason: LONG }] }), null, 'a reason is enough, even with a continue verdict');
  assert.equal(await checkEscalations(deps(), open, { directive_ids: [A], escalations: [{ subject: esc().subject, directive_id: A }] }), null);
  assert.equal((await checkEscalations(deps(), open, { directive_ids: [], escalations: [{ subject: esc().subject, directive_id: A }] }))?.error, 'escalation_directive_not_in_review');
  assert.equal((await checkEscalations(deps({ toAgentId: 'someone-else' }), open, { directive_ids: [A], escalations: [{ subject: esc().subject, directive_id: A }] }))?.error, 'escalation_directive_wrong_agent');
  assert.equal((await checkEscalations(deps(null), open, { directive_ids: [A], escalations: [{ subject: esc().subject, directive_id: A }] }))?.error, 'escalation_directive_wrong_agent');
  assert.equal((await checkEscalations(deps(), open, { directive_ids: [], escalations: [{ subject: esc().subject, decline_reason: LONG }, { subject: 'escalation:x:y', decline_reason: LONG }] }))?.error, 'escalation_unknown');
  // Several problems come back at once.
  const many = await checkEscalations(deps(), { escalations: [esc(), esc({ subject: 'escalation:ai_global:posts', kind: 'posts', directive_ids: [] })] }, { directive_ids: [], escalations: [] });
  assert.equal(many?.problems?.length, 2);
});

test('submit_review: refused while an escalation is open and unanswered, stored with the answers once it is answered', async () => {
  const reviews: any[] = [];
  const dg = { ...baseDigest(), generatedAt: NOW.toISOString(), hash: 'h1', escalations: [esc()] } as unknown as KpiDigest;
  const tools = buildDirectiveTools({
    repo: { addReview: async (r: any) => { reviews.push(r); }, get: async () => ({ id: A, toAgentId: 'a1' }) } as any,
    agents: { getByHandle: async (h: string) => (h === 'ai_global' ? { id: 'a1' } : null), findTop: async () => null } as any,
    digest: { build: async () => dg, render: () => '{}' }, inbox: { post: async () => 1 }, memory: { listActive: async () => [] }, actions: { propose: async () => ({}) as any },
    channelKeyOf: async () => null,
  });
  const submit = tools.find((t) => t.name === 'submit_review')!;
  const ctx = { runId: 'r', role: 'manager' as const, channelKey: null, extras: { digest: dg } } as any;
  const parse = (o: Record<string, unknown>) => submit.input.parse({ verdict: 'continue', summary: 'Нічого міняти не треба', quality_check: [], ...o });

  assert.deepEqual(submit.input.parse({ verdict: 'continue', summary: 'Все гаразд тут', quality_check: [] }).escalations, [], 'escalations defaults to []');
  const refused: any = await submit.execute(parse({}), ctx);
  assert.equal(refused.error, 'escalation_unaddressed');
  assert.equal(reviews.length, 0);
  const short: any = await submit.execute(parse({ escalations: [{ subject: esc().subject, decline_reason: 'ні' }] }), ctx);
  assert.equal(short.error, 'escalation_reason_required');
  const ok: any = await submit.execute(parse({ escalations: [{ subject: esc().subject, decline_reason: LONG }] }), ctx);
  assert.equal(ok.ok, true);
  assert.equal(reviews.length, 1);
  assert.match(reviews[0].summary, /ескалація escalation:ai_global:voice_fix: без директиви — Порада вже відкрита/, 'the answer is part of the stored review');
  const filed: any = await submit.execute(parse({ verdict: 'directives', directive_ids: [A], escalations: [{ subject: esc().subject, directive_id: A }] }), ctx);
  assert.equal(filed.ok, true);
  assert.match(reviews[1].summary, /директива 11111111/);

  // Without an open escalation nothing changes for the old shape of a review.
  const plain: any = await submit.execute(parse({}), { ...ctx, extras: { digest: { ...dg, escalations: undefined } } });
  assert.equal(plain.ok, true);
});

test('eleven open escalations can all be answered: submit_review takes as many answers as the digest can list', async () => {
  const subjects = Array.from({ length: 11 }, (_, i) => `escalation:agent_${i}:posts`);
  const list = subjects.map((subject, i) => esc({ subject, agent: `agent_${i}`, kind: 'posts', directive_ids: [], days: 3 }));
  const answers = subjects.map((subject) => ({ subject, decline_reason: LONG }));
  const parsed = SubmitReviewInput.safeParse({ verdict: 'continue', summary: 'Нічого міняти не треба', quality_check: [], escalations: answers });
  assert.equal(parsed.success, true, 'eleven answers parse');
  assert.equal(await checkEscalations(deps(), { escalations: list }, { directive_ids: [], escalations: answers }), null, 'and answer all eleven');
  assert.equal((await checkEscalations(deps(), { escalations: list }, { directive_ids: [], escalations: answers.slice(0, 10) }))?.error, 'escalation_unaddressed');
  const tooMany = Array.from({ length: ESCALATION_ANSWERS_MAX + 1 }, (_, i) => ({ subject: `escalation:agent_${i}:posts`, decline_reason: LONG }));
  assert.equal(SubmitReviewInput.safeParse({ verdict: 'continue', summary: 'Нічого міняти не треба', quality_check: [], escalations: tooMany }).success, false);
});

test('openEscalations lists at most as many as submit_review takes answers for (the oldest first), so a review can answer every one it is shown', async () => {
  const rows = Array.from({ length: ESCALATION_ANSWERS_MAX + 5 }, (_, i) => ({
    subject: `escalation:agent_${String(i).padStart(3, '0')}:posts`, parts: ['posts_from:2026-10-23', 'days:3'], title: 'Manager escalation: posts below the norm',
    created_at: new Date(Date.UTC(2026, 9, 20, 0, i)),
  }));
  const list = await openEscalations({ query: async () => ({ rows }) } as any, NOW);
  assert.equal(list.length, ESCALATION_ANSWERS_MAX);
  assert.ok(list.every((e) => Number(e.subject.match(/agent_(\d+)/)![1]) < ESCALATION_ANSWERS_MAX), 'the five newest wait until older ones are read');
  assert.deepEqual(list.map((e) => e.subject), [...list.map((e) => e.subject)].sort((a, b) => a.localeCompare(b)), 'still in the stable subject order');
});

// ── cadence ────────────────────────────────────────────────────────────────

test('the manager looks once a day by default (09:00); the evening time is gone', () => {
  assert.deepEqual(DEFAULT_MANAGER_TIMES, ['09:00']);
  const r = new ManagerRunner({
    loop: { run: async () => ({}) as any }, registry: { forRole: () => [] }, runtime: { forAgent: async () => ({}) as any },
    agents: { findTop: async () => null, get: async () => null, list: async () => [] } as any,
    repo: {} as any, digest: { build: async () => ({}) as any, render: () => '{}', snapshot: async () => 1 }, inbox: { post: async () => 1 }, env: () => undefined,
  });
  const at = (h: string) => new Date(`2026-10-26T${h}:00+02:00`); // Kyiv is UTC+2 after 25.10
  const m = { schedule: {} } as any;
  assert.equal(r.dueSlot(m, at('08:59')), null);
  assert.equal(r.dueSlot(m, at('09:05')), '2026-10-26@09:00');
  assert.equal(r.dueSlot(m, at('19:30')), '2026-10-26@09:00', 'there is no 19:00 slot any more');
});

// ── the hourly housekeeping runs it ────────────────────────────────────────

test('housekeeping runs escalate() after the verification and reports how many notes it posted; a failing escalate does not break it', async () => {
  const posted: any[] = [];
  const memory: any[] = [];
  const repo = {
    awaitingOwnerOlderThan: async () => [], update: async () => null, droppedInARow: async () => 0, unanswered: async () => [], expireShadowUnanswered: async () => 0,
    contestedOlderThan: async () => [], acceptedForExecution: async () => [], dueSeriesResumes: async () => [], awaitingVerification: async () => [],
    dueForEvaluation: async () => [], overlapping: async () => 0, addMemory: async (...a: any[]) => { memory.push(a); },
    notFollowedGroups: async () => [group([A, B])], negativePostsDays: async () => [], filedSince: async () => 0,
  };
  const make = (inbox: any) => new ManagerRunner({
    loop: { run: async () => ({}) as any }, registry: { forRole: () => [] }, runtime: { forAgent: async () => ({}) as any },
    agents: { findTop: async () => ({ id: 'm1', handle: 'manager' }) as any, get: async () => null, list: async () => [] } as any,
    repo: repo as any, digest: { build: async () => ({ resources: [], directives: { open: [] }, raw: new Map() }) as any, render: () => '{}', snapshot: async () => 1 },
    inbox, env: () => undefined, now: () => NOW,
  });
  const r = await make({ post: async () => 1, postOnce: async (i: any) => { posted.push(i); return posted.length; } }).housekeeping();
  assert.equal(r.escalated, 1);
  assert.equal(posted[0].kind, 'manager_escalation');
  assert.equal(memory.length, 1);
  const failing = await make({ post: async () => 1, postOnce: async () => { throw new Error('db down'); } }).housekeeping();
  assert.equal(failing.escalated, 0);
});
