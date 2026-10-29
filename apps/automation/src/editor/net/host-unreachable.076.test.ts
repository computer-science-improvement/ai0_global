/**
 * Spec 076 FR-002 (A5, A6, A7): timeouts in a row become an `unreachable` strike. The pure `nextBlock` only; the row
 * (`record`, `succeeded`) is covered by source-reach.076.pg.test.ts. The 061 / 070 cases stay in their own files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextBlock, UNREACHABLE_TIMEOUTS, UNREACHABLE_WINDOW_DAYS,
  type HostFailureReason, type NextBlock, type PrevBlock,
} from './host-failures';
import { SlotPreflight } from '../preflight/slot-preflight';
import { makeCard } from '../post/testing/fixtures';

const T0 = new Date('2026-10-20T08:00:00Z');
const plus = (d: Date, hours: number) => new Date(d.getTime() + hours * 3_600_000);

/** The row as `record` leaves it after `next` (the reason and status code stay when the block is kept). */
function rowAfter(prev: PrevBlock | null, next: NextBlock, now: Date): PrevBlock {
  return {
    reason: next.keep && prev ? prev.reason : next.reason, blockedUntil: next.until, strikes: next.strikes,
    timeouts: next.timeouts, timeoutsSince: next.timeoutsSince, lastAt: now,
  };
}

/** Feeds failures to `nextBlock` one after the other, the way `record` does, and returns each step. */
function run(events: Array<[number, HostFailureReason]>, start: PrevBlock | null = null): Array<{ at: Date; next: NextBlock; row: PrevBlock }> {
  const out: Array<{ at: Date; next: NextBlock; row: PrevBlock }> = [];
  let row = start;
  for (const [hours, reason] of events) {
    const at = plus(T0, hours);
    const next = nextBlock(row, reason, at);
    row = rowAfter(row, next, at);
    out.push({ at, next, row });
  }
  return out;
}

test('three counted timeouts at least an hour apart are an unreachable strike: 1 d, then 3 d, then 7 d', () => {
  assert.equal(UNREACHABLE_TIMEOUTS, 3);
  const s = run([[0, 'timeout'], [2, 'timeout'], [4, 'timeout']]);
  assert.deepEqual([s[0].next.reason, s[0].next.strikes, s[0].next.timeouts], ['timeout', 0, 1]);
  assert.equal(s[0].next.until.toISOString(), plus(T0, 1).toISOString());
  assert.deepEqual([s[1].next.reason, s[1].next.strikes, s[1].next.timeouts], ['timeout', 0, 2]);
  assert.deepEqual([s[2].next.reason, s[2].next.strikes, s[2].next.timeouts, s[2].next.keep], ['unreachable', 1, 3, false]);
  assert.equal(s[2].next.until.toISOString(), plus(T0, 4 + 24).toISOString(), 'the first strike is a day');
  assert.equal(s[2].next.timeoutsSince?.toISOString(), T0.toISOString(), 'the streak began with the first timeout');
  // The next timeout after the block, with no success between, is the next strike.
  const after1 = run([[29, 'timeout']], s[2].row)[0].next;
  assert.deepEqual([after1.reason, after1.strikes, after1.timeouts], ['unreachable', 2, 4]);
  assert.equal(after1.until.toISOString(), plus(T0, 29 + 72).toISOString(), 'then 3 d');
  const after2 = run([[29 + 73, 'timeout']], rowAfter(s[2].row, after1, plus(T0, 29)))[0].next;
  assert.deepEqual([after2.strikes, after2.until.toISOString()], [3, plus(T0, 29 + 73 + 168).toISOString()]);
  const after3 = run([[29 + 73 + 169, 'timeout']], rowAfter(null, after2, plus(T0, 29 + 73)))[0].next;
  assert.deepEqual([after3.strikes, after3.until.toISOString()], [4, plus(T0, 29 + 73 + 169 + 168).toISOString()], '7 d is the cap');
});

test('A6: a timeout inside an active timeout block is the same attempt and counts nothing', () => {
  const s = run([[0, 'timeout'], [0.25, 'timeout']]);
  assert.deepEqual([s[1].next.timeouts, s[1].next.strikes, s[1].next.reason, s[1].next.keep], [1, 0, 'timeout', false]);
  assert.equal(s[1].next.until.toISOString(), plus(T0, 1.25).toISOString(), 'the 061 behaviour: the block moves to an hour from the new attempt');
  // Ten timeouts inside one block never reach the strike.
  const many = run(Array.from({ length: 10 }, (_, i) => [i * 0.05, 'timeout'] as [number, HostFailureReason]));
  assert.ok(many.every((x) => x.next.reason === 'timeout' && x.next.timeouts === 1));
});

test('A6: a timeout inside an unreachable block stays unreachable, keeps the strike and ends at least an hour from now', () => {
  const block: PrevBlock = { reason: 'unreachable', blockedUntil: plus(T0, 0.5), strikes: 1, timeouts: 3, timeoutsSince: plus(T0, -4), lastAt: plus(T0, -23.5) };
  const near = nextBlock(block, 'timeout', T0);
  assert.deepEqual([near.reason, near.strikes, near.timeouts, near.keep], ['unreachable', 1, 3, true]);
  assert.equal(near.until.toISOString(), plus(T0, 1).toISOString(), '30 min left: now + 1 h');
  const far = nextBlock({ ...block, blockedUntil: plus(T0, 20) }, 'timeout', T0);
  assert.equal(far.until.toISOString(), plus(T0, 20).toISOString(), 'a longer end is kept');
});

test('A6: a timeout inside a longer block of another reason keeps that block and does not count', () => {
  const refused: PrevBlock = { reason: 'refused', blockedUntil: plus(T0, 70), strikes: 2, timeouts: 1, timeoutsSince: plus(T0, -3), lastAt: plus(T0, -2) };
  const kept = nextBlock(refused, 'timeout', plus(T0, 5));
  assert.deepEqual([kept.reason, kept.strikes, kept.timeouts, kept.keep, kept.until.toISOString()], ['refused', 2, 1, true, refused.blockedUntil.toISOString()]);
  // With under an hour left the timeout counts like any other.
  const ending = nextBlock({ ...refused, blockedUntil: plus(T0, 5.5) }, 'timeout', plus(T0, 5));
  assert.deepEqual([ending.reason, ending.timeouts, ending.keep], ['timeout', 2, false]);
});

test('A7: the count slides on the last failure; a host quiet for over 14 days starts over, the strikes stay', () => {
  assert.equal(UNREACHABLE_WINDOW_DAYS, 14);
  const stale: PrevBlock = { reason: 'timeout', blockedUntil: plus(T0, 1), strikes: 2, timeouts: 2, timeoutsSince: plus(T0, -24 * 20), lastAt: plus(T0, -24 * 14 - 1) };
  const restart = nextBlock(stale, 'timeout', plus(T0, 2));
  assert.deepEqual([restart.reason, restart.timeouts, restart.strikes], ['timeout', 1, 2], 'a plain hour again, with the strikes kept');
  assert.equal(restart.timeoutsSince?.toISOString(), plus(T0, 2).toISOString());
  const live = nextBlock({ ...stale, lastAt: plus(T0, -24 * 13) }, 'timeout', plus(T0, 2));
  assert.deepEqual([live.reason, live.timeouts, live.strikes], ['unreachable', 3, 3], 'inside the window the 3rd timeout is a strike');
  // No row at all, or a row without a last failure: count 1.
  assert.equal(nextBlock(null, 'timeout', T0).timeouts, 1);
  assert.equal(nextBlock({ reason: 'timeout', blockedUntil: plus(T0, -1), strikes: 0, timeouts: 2 }, 'timeout', T0).timeouts, 1);
});

test('A7 day 18: a host that always times out has strikes on days 0, 1, 4 and 11; the first request on day 18 is strike 5 (7 d)', () => {
  const day = (d: number, h = 0) => d * 24 + h;
  const s = run([
    [day(0), 'timeout'], [day(0, 2), 'timeout'], [day(0, 4), 'timeout'], // strike 1 (1 d, to day 1 + 4 h)
    [day(1, 5), 'timeout'],                                              // strike 2 (3 d, to day 4 + 5 h)
    [day(4, 6), 'timeout'],                                              // strike 3 (7 d, to day 11 + 6 h)
    [day(11, 7), 'timeout'],                                             // strike 4 (7 d, to day 18 + 7 h)
    [day(18, 8), 'timeout'],                                             // strike 5
  ]);
  assert.deepEqual(s.map((x) => x.next.strikes), [0, 0, 1, 2, 3, 4, 5]);
  assert.equal(s[6].next.reason, 'unreachable');
  assert.equal(s[6].next.until.toISOString(), plus(s[6].at, 168).toISOString(), 'a plain 1 h block would have hidden the host again');
});

test('a refusal, DNS, TLS or feed failure leaves the timeout count alone; a refusal inside an unreachable block keeps it', () => {
  const row: PrevBlock = { reason: 'timeout', blockedUntil: plus(T0, -1), strikes: 0, timeouts: 2, timeoutsSince: plus(T0, -5), lastAt: plus(T0, -2) };
  for (const reason of ['refused', 'dns', 'tls', 'feed_unparseable', 'feed_refused'] as const) {
    const n = nextBlock(row, reason, T0);
    assert.deepEqual([n.timeouts, n.timeoutsSince?.toISOString()], [2, plus(T0, -5).toISOString()], reason);
  }
  // The count survives a refusal, so the next timeout (after the refusal block) is the 3rd.
  const refusal = nextBlock(row, 'refused', T0);
  assert.deepEqual([refusal.reason, refusal.strikes, refusal.timeouts], ['refused', 1, 2]);
  const afterBlock = nextBlock(rowAfter(row, refusal, T0), 'timeout', plus(T0, 25));
  assert.deepEqual([afterBlock.reason, afterBlock.timeouts, afterBlock.strikes], ['unreachable', 3, 2]);

  const unreachable: PrevBlock = { reason: 'unreachable', blockedUntil: plus(T0, 20), strikes: 1, timeouts: 3, timeoutsSince: plus(T0, -4), lastAt: plus(T0, -4) };
  const inside = nextBlock(unreachable, 'refused', T0);
  assert.deepEqual([inside.reason, inside.strikes, inside.keep, inside.until.toISOString()], ['unreachable', 1, true, unreachable.blockedUntil.toISOString()]);
});

test('a row from before migration 100 (no timeout fields) reads as zero timeouts', () => {
  const legacy: PrevBlock = { reason: 'refused', blockedUntil: plus(T0, -1), strikes: 1 };
  const n = nextBlock(legacy, 'timeout', T0);
  assert.deepEqual([n.reason, n.timeouts, n.strikes], ['timeout', 1, 1]);
  const r = nextBlock(legacy, 'refused', T0);
  assert.deepEqual([r.strikes, r.timeouts, r.timeoutsSince], [2, 0, null]);
});

test('assessUrl: a planned URL slot on an unreachable host is preflight_host_blocked; a one-hour timeout block still lets it through', async () => {
  const pf = (reason: HostFailureReason) => new SlotPreflight({
    ledger: { check: async () => ({ used: false }) } as any,
    hosts: { blocked: async (host: string) => ({ host, reason, statusCode: null, until: plus(T0, 20) }) },
    ideas: { idea: async () => null, accepted: async () => [], claim: async () => true, release: async () => undefined },
    retopic: async () => undefined, env: () => undefined, freshnessHours: async () => null, now: () => T0,
  });
  const slot = { channelKey: '@pdr', format: 'text', sourceHints: ['https://zakon.rada.gov.ua/laws/show/1306-2001-%D0%BF/print#%D0%BF.14.6'] };
  const blocked = await pf('unreachable').assessPlanned(slot, makeCard());
  assert.equal(blocked?.code, 'preflight_host_blocked');
  assert.match(blocked?.reason ?? '', /zakon\.rada\.gov\.ua/);
  assert.equal(await pf('timeout').assessPlanned(slot, makeCard()), null, 'a slow site is not a dead one');
});
