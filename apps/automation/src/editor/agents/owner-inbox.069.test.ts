// Spec 069 FR-004 / A9 / A10 on fakes: the card sink runs before the older cards are closed (so it can edit one in place),
// the third note of a run nobody reacted to is posted as info, and a standalone (past-day) note answers nothing.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OwnerInbox, setInboxCardSink, setInboxSupersedeSink, type InboxItemInput } from './owner-inbox';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const PARTS = ['missed:Prompt:nothing_fresh'];

interface PoolOpts { past?: Array<{ parts: string[] | null; created_at: Date }>; acted?: boolean; actedThrows?: boolean; superseded?: number[] }

function fakePool(o: PoolOpts = {}) {
  const inserted: unknown[][] = [];
  const sql: string[] = [];
  return {
    inserted, sql,
    async query(text: string, params: unknown[] = []) {
      sql.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
      if (/SELECT parts, created_at FROM agent_inbox/.test(text)) return { rows: o.past ?? [] };
      if (/INSERT INTO agent_inbox/.test(text)) { inserted.push(params); return { rows: [{ id: 100 + inserted.length }] }; }
      if (/UPDATE agent_inbox SET read_at/.test(text)) return { rows: (o.superseded ?? []).map((id) => ({ id })) };
      if (/UPDATE agent_inbox SET actions/.test(text)) return { rows: [] };
      if (/FROM owner_cards c JOIN agent_inbox/.test(text)) {
        if (o.actedThrows) throw new Error('relation "owner_cards" does not exist');
        return { rows: o.acted ? [{ '?column?': 1 }] : [] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  } as any;
}

const note = (over: Partial<Omit<InboxItemInput, 'refType' | 'refId'>> = {}): InboxItemInput & { refType: string; refId: string } => ({
  kind: 'series_missed', severity: 'action', title: 'Series missed', body: 'b', refType: 'resource_day', refId: 'telegram:@x|2026-10-22',
  gate: { subject: 'silent:telegram:@x:miss', parts: PARTS }, ...over,
});

afterEach(() => { setInboxCardSink(null); setInboxSupersedeSink(null); });

test('the card sink hears the superseded ids; a card it edited in place is not closed, the others are', async () => {
  const sunk: Array<{ id: number; replaces?: number[] }> = [];
  const closed: number[][] = [];
  setInboxSupersedeSink(async (ids) => { closed.push(ids); });

  setInboxCardSink(async (id, _i, o) => { sunk.push({ id, replaces: o?.replaces }); return { retargeted: 7 }; });
  await new OwnerInbox(fakePool({ superseded: [7] })).postOnce(note());
  assert.deepEqual([...sunk], [{ id: 101, replaces: [7] }]);
  assert.deepEqual(closed, [], 'the only superseded note was edited in place: nothing to close');

  setInboxCardSink(async (id, _i, o) => { sunk.push({ id, replaces: o?.replaces }); return { retargeted: 7 }; });
  await new OwnerInbox(fakePool({ superseded: [5, 7] })).postOnce(note());
  assert.deepEqual(closed, [[5]], 'the sink took one card; the rest of the older notes are closed');

  closed.length = 0;
  setInboxCardSink(async () => true);
  await new OwnerInbox(fakePool({ superseded: [5, 7] })).postOnce(note());
  assert.deepEqual(closed, [[5, 7]], 'a plain true (a new card was made) closes every older card, after the sink');
});

test('without a card sink the plain alert goes out and the superseded cards are still reported', async () => {
  const alerts: string[] = [];
  const closed: number[][] = [];
  setInboxSupersedeSink(async (ids) => { closed.push(ids); });
  await new OwnerInbox(fakePool({ superseded: [7] }), async (t) => { alerts.push(t); }).postOnce(note());
  assert.equal(alerts.length, 1);
  assert.deepEqual(closed, [[7]]);
});

test('a standalone note (a past day told late) supersedes nothing and gives the sink no replaces', async () => {
  const pool = fakePool({ superseded: [7] });
  const seen: Array<number[] | undefined> = [];
  const closed: number[][] = [];
  setInboxSupersedeSink(async (ids) => { closed.push(ids); });
  setInboxCardSink(async (_id, _i, o) => { seen.push(o?.replaces); return true; });
  await new OwnerInbox(pool).postOnce(note({ gate: { subject: 'silent:telegram:@x:miss', parts: PARTS, standalone: true } }));
  assert.deepEqual(seen, [[]]);
  assert.deepEqual(closed, []);
  assert.ok(!pool.sql.includes('UPDATE agent_inbox SET'), 'no UPDATE that marks older notes read');
});

test('the third note of a run nobody reacted to is stored as info and sends no plain alert', async () => {
  // Two earlier notes of the subject, 3 and 6 days old: this one is the third of the run (the repeat rhythm).
  const earlier = [{ parts: PARTS, created_at: ago(3) }, { parts: PARTS, created_at: ago(6) }];
  const alerts: string[] = [];
  const pool = fakePool({ past: earlier });
  const id = await new OwnerInbox(pool, async (t) => { alerts.push(t); }).postOnce(note());
  assert.equal(id, 101);
  assert.equal(pool.inserted[0][6], 'info', 'severity stored as info');
  assert.deepEqual(alerts, [], 'a demoted note never falls back to the plain alert');
  assert.match(String(pool.inserted[0][2]), /still going, 6 days/, 'the "still" wording is kept (counted from the first note of the run)');

  // The card sink is told it is an info note (it keeps no card for it).
  const seen: Array<string | undefined> = [];
  setInboxCardSink(async (_id, i) => { seen.push(i.severity); return true; });
  await new OwnerInbox(fakePool({ past: earlier })).postOnce(note());
  assert.deepEqual(seen, ['info']);
});

test('the first two notes of a run, a critical note, and a run the owner reacted to keep their severity', async () => {
  const sev = async (p: PoolOpts, over: Partial<InboxItemInput> = {}) => {
    const pool = fakePool(p);
    await new OwnerInbox(pool).postOnce(note(over));
    return pool.inserted[0][6];
  };
  assert.equal(await sev({}), 'action', 'the first');
  assert.equal(await sev({ past: [{ parts: PARTS, created_at: ago(3) }] }), 'action', 'the second');
  const third = { past: [{ parts: PARTS, created_at: ago(3) }, { parts: PARTS, created_at: ago(6) }] };
  assert.equal(await sev(third), 'info');
  assert.equal(await sev(third, { severity: 'critical' }), 'critical', 'never demoted');
  assert.equal(await sev({ ...third, acted: true }), 'action', 'a card of the run was resolved from Telegram');
  assert.equal(await sev({ ...third, actedThrows: true }), 'action', 'a failed lookup is not a reason to go quiet');
  // A gap of more than repeatDays + 1 days ends the run: the third note after a break is a first again.
  assert.equal(await sev({ past: [{ parts: PARTS, created_at: ago(3) }, { parts: PARTS, created_at: ago(12) }] }), 'action');
});

test('the owner-action lookup asks about the run only: notes of the subject since its first note', async () => {
  const earlier = [{ parts: PARTS, created_at: ago(3) }, { parts: PARTS, created_at: ago(6) }];
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const base = fakePool({ past: earlier });
  const pool = { query: async (text: string, params: unknown[] = []) => { queries.push({ text, params }); return base.query(text, params); } } as any;
  await new OwnerInbox(pool).postOnce(note());
  const q = queries.find((x) => /owner_cards/.test(x.text))!;
  assert.match(q.text, /resolved_by LIKE 'telegram:%'/);
  assert.equal(q.params[0], 'silent:telegram:@x:miss');
  assert.equal(Math.round((Date.now() - (q.params[1] as Date).getTime()) / DAY), 6, 'from the oldest note of the run');
});
