import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Fix } from '../sysadmin/audit.types';
import { ChannelNotFound } from './facts';
import {
  AUTO_FIX_REASONS, BLOCKER_STABLE_MS, STAMP_GATE_MS, STAMP_REASONS, VIEW_WINDOW_MS,
  type RecheckEvent, type RecheckReason,
} from './readiness.service';
import { CH, makeFacts } from './testing/facts-fixture';
import { harness, HOUR, mkF, MIN, type Harness } from './testing/fake-readiness';

/**
 * Spec 072 T6, FR-006, A9, A10, A11, A13, A20, A27, I5: the service over fakes. Each row of the A10 table, the stamp and the
 * clear, the carried `auto_fixed` rows, the fix scopes, the hooks, the lock and the key spelling.
 */

const HASHTAG: Fix = { kind: 'hashtag_min_zero', channel: CH };
const autoFinding = () => mkF('hashtag_min_without_vocabulary', 'error', { id: CH, fix: HASHTAG });
const blockerB = () => mkF('series_source_contradicted', 'error', { id: 'B' });

/** A channel whose blocker B has been open for ten minutes already (so it counts for the card), plus the auto-fixable hashtag minimum. */
function seeded(h: Harness, extra = true) {
  h.state.findings = [blockerB(), ...(extra ? [autoFinding()] : [])];
  h.onFix.current = (what) => { if (what === 'hashtag') h.state.findings = h.state.findings.filter((f) => f.check !== 'hashtag_min_without_vocabulary'); };
  h.repo.rows.set(CH, {
    channelKey: CH, findings: [{ ...blockerB(), firstSeenAt: new Date(h.clock.now.getTime() - 10 * MIN).toISOString() }], blockers: 1, warnings: 0,
    configHash: 'old-hash', appliedHash: 'applied-by-074', checkedAt: new Date(h.clock.now.getTime() - 10 * MIN), notifiedAt: null, notifiedBlockers: [],
  });
}

// ── A10: what each reason does ────────────────────────────────────────────────────────────────────────────────────

const MATRIX: Array<[RecheckReason, boolean, boolean]> = [
  // reason, auto-fix, notify stamp
  ['owner', true, true], ['sweep', true, true], ['start', true, true], ['config_skip', false, true], ['fix', false, true], ['view', false, false],
];

for (const [reason, autoFix, stamp] of MATRIX) {
  test(`A10 ${reason}: auto-fix ${autoFix ? 'yes' : 'no'}, notify stamp ${stamp ? 'yes' : 'no'}, hooks yes`, async () => {
    const h = harness();
    seeded(h);
    const seen: RecheckReason[] = [];
    h.svc.afterRecheck((e) => { seen.push(e.reason); });
    await h.svc.recheck(CH, reason);
    assert.equal(h.calls.hashtag.length, autoFix ? 1 : 0, 'the auto-safe fix');
    assert.equal(h.calls.load, autoFix ? 2 : 1, 'facts are reloaded once after an auto-fix, never otherwise');
    assert.equal(h.calls.doctor, autoFix ? 2 : 1);
    const row = h.repo.rows.get(CH)!;
    assert.deepEqual(row.notifiedBlockers, stamp ? [blockerB().key] : [], 'the stamp');
    assert.equal(row.notifiedAt?.toISOString() ?? null, stamp ? h.clock.now.toISOString() : null);
    assert.deepEqual(seen, [reason]);
  });
}

test('A10: the reason sets are the table', () => {
  assert.deepEqual([...AUTO_FIX_REASONS].sort(), ['owner', 'start', 'sweep']);
  assert.deepEqual([...STAMP_REASONS].sort(), ['config_skip', 'fix', 'owner', 'start', 'sweep']);
});

test('a channel outside the sweep set is neither fixed nor stamped, whatever the reason', async () => {
  const h = harness({ sweep: false });
  seeded(h);
  await h.svc.recheck(CH, 'owner');
  assert.equal(h.calls.hashtag.length, 0);
  assert.deepEqual(h.repo.rows.get(CH)!.notifiedBlockers, []);
  assert.equal(h.repo.rows.get(CH)!.blockers, 2, 'it is still checked and stored');
});

test('READINESS_AUTO_FIX off: the findings are reported and nothing is applied', async () => {
  const h = harness();
  seeded(h);
  h.state.autoFix = false;
  await h.svc.recheck(CH, 'sweep');
  assert.equal(h.calls.hashtag.length, 0);
  assert.equal(h.calls.load, 1);
  assert.ok(h.repo.rows.get(CH)!.findings.some((f) => f.check === 'hashtag_min_without_vocabulary'));
});

test('an auto-fix applies each distinct fix once, then reloads once and runs the doctor once more', async () => {
  const h = harness();
  const tools: Fix = { kind: 'tools_allow_add', channel: CH, tools: ['fetch_feed'] };
  h.state.findings = [
    mkF('tools_missing_for_source', 'error', { id: 'a', fix: tools }), mkF('tools_missing_for_source', 'warn', { id: 'b', fix: tools }), autoFinding(),
    mkF('series_source_not_required', 'warn', { id: 'c', fix: { kind: 'series_source_require', channel: CH, series: 'S' } }),
  ];
  h.onFix.current = () => { h.state.findings = []; };
  await h.svc.recheck(CH, 'owner');
  assert.deepEqual(h.calls.tools, [[CH, ['fetch_feed']]], 'the same fix twice = one call');
  assert.equal(h.calls.hashtag.length, 1);
  assert.equal(h.calls.load, 2);
  assert.equal(h.calls.doctor, 2, 'not a loop');
  const kinds = h.repo.rows.get(CH)!.findings.filter((f) => f.check === 'auto_fixed').map((f) => (f.evidence.fix as Fix).kind).sort();
  assert.deepEqual(kinds, ['hashtag_min_zero', 'tools_allow_add'], 'series_source_require is a one-tap fix, never an auto-safe one');
  assert.equal(h.calls.logs.filter((l) => /by itself/.test(l)).length, 2, 'one line per applied fix');
});

test('an auto-fix that the port refuses stays an open finding, is logged, and does not stop the others', async () => {
  const h = harness({ fixes: { setHashtagMin: async () => { throw Object.assign(new Error('x'), { response: { error: 'channel_not_found', details: CH } }); } } });
  h.state.findings = [autoFinding(), mkF('tools_missing_for_source', 'warn', { id: 'a', fix: { kind: 'tools_allow_add', channel: CH, tools: ['query_data'] } })];
  await h.svc.recheck(CH, 'sweep');
  assert.equal(h.calls.tools.length, 1);
  assert.ok(h.calls.logs.some((l) => /refused \(hashtag_min_zero\): channel_not_found/.test(l)));
  assert.equal(h.repo.rows.get(CH)!.findings.filter((f) => f.check === 'auto_fixed').length, 1);
});

// ── the stored row ────────────────────────────────────────────────────────────────────────────────────────────────

test('a recheck stores the findings with counts, the config hash and the time; applied_hash is never written', async () => {
  const h = harness();
  seeded(h);
  h.state.autoFix = false;
  h.state.findings = [blockerB(), mkF('dataset_low_fill', 'warn'), mkF('series_paused', 'info', { id: 'p' })];
  const view = await h.svc.recheck(CH, 'sweep');
  const row = h.repo.rows.get(CH)!;
  assert.equal(row.blockers, 1);
  assert.equal(row.warnings, 1);
  assert.match(row.configHash, /^[0-9a-f]{64}$/);
  assert.equal(row.checkedAt.toISOString(), h.clock.now.toISOString());
  assert.equal(row.appliedHash, 'applied-by-074', 'the column stays what 074 wrote');
  assert.equal(h.repo.appliedHashWrites, 0, 'a recheck never calls setAppliedHash');
  assert.ok(h.repo.upserts.every((w) => !('appliedHash' in w)));
  assert.equal(view.infos, 1);
  assert.equal(view.blockers + view.warnings + view.infos, 3);
});

test('firstSeenAt is kept for a finding that stays open, starts again for one that closed and came back', async () => {
  const h = harness();
  h.state.autoFix = false;
  h.state.findings = [blockerB(), mkF('dataset_low_fill', 'warn')];
  await h.svc.recheck(CH, 'sweep');
  const t0 = h.clock.now.toISOString();
  h.clock.advance(HOUR);
  h.state.findings = [blockerB()];
  await h.svc.recheck(CH, 'sweep');
  const afterOne = h.repo.rows.get(CH)!.findings;
  assert.equal(afterOne.find((f) => f.check === 'series_source_contradicted')!.firstSeenAt, t0);
  h.clock.advance(HOUR);
  h.state.findings = [blockerB(), mkF('dataset_low_fill', 'warn')];
  await h.svc.recheck(CH, 'sweep');
  const back = h.repo.rows.get(CH)!.findings;
  assert.equal(back.find((f) => f.check === 'series_source_contradicted')!.firstSeenAt, t0);
  assert.equal(back.find((f) => f.check === 'dataset_low_fill')!.firstSeenAt, h.clock.now.toISOString(), 'it was gone in between');
});

// ── A9, I5: the stamp and the clear ───────────────────────────────────────────────────────────────────────────────

test('I5: one recheck never stamps; a blocker has to be open for five minutes first', async () => {
  const h = harness();
  h.state.autoFix = false;
  h.state.findings = [blockerB()];
  await h.svc.recheck(CH, 'sweep');
  assert.deepEqual(h.repo.rows.get(CH)!.notifiedBlockers, [], 'the first sight');
  h.clock.advance(4 * MIN);
  await h.svc.recheck(CH, 'sweep');
  assert.deepEqual(h.repo.rows.get(CH)!.notifiedBlockers, [], 'four minutes');
  h.clock.advance(BLOCKER_STABLE_MS - 4 * MIN + 1);
  await h.svc.recheck(CH, 'sweep');
  assert.deepEqual(h.repo.rows.get(CH)!.notifiedBlockers, [blockerB().key], 'five minutes after the first sight');
});

test('A9: at most one stamp in 24 hours, a clear at once outside the gate, and the same set again after the gate stamps again', async () => {
  const h = harness();
  h.state.autoFix = false;
  const A = mkF('series_source_contradicted', 'error', { id: 'A' });
  const C = mkF('dataset_without_series', 'error', { id: 'C' });
  h.repo.rows.set(CH, { channelKey: CH, findings: [], blockers: 0, warnings: 0, configHash: '', appliedHash: null, checkedAt: new Date(h.clock.now.getTime() - HOUR), notifiedAt: null, notifiedBlockers: [] });

  h.state.findings = [A];
  await h.svc.recheck(CH, 'sweep');
  h.clock.advance(10 * MIN);
  await h.svc.recheck(CH, 'sweep');
  const stamped = h.repo.rows.get(CH)!.notifiedAt!;
  assert.deepEqual(h.repo.rows.get(CH)!.notifiedBlockers, [A.key]);
  assert.equal(stamped.toISOString(), h.clock.now.toISOString());

  // A second, different set inside 24 hours is not stamped.
  h.clock.advance(10 * MIN);
  h.state.findings = [A, C];
  await h.svc.recheck(CH, 'sweep');
  h.clock.advance(10 * MIN);
  await h.svc.recheck(CH, 'sweep');
  assert.deepEqual(h.repo.rows.get(CH)!.notifiedBlockers, [A.key], 'one stamp per 24 hours');
  assert.equal(h.repo.rows.get(CH)!.notifiedAt!.toISOString(), stamped.toISOString());

  // Cleared at once, inside the gate, and notified_at stays.
  h.state.findings = [];
  h.clock.advance(MIN);
  await h.svc.recheck(CH, 'sweep');
  assert.deepEqual(h.repo.rows.get(CH)!.notifiedBlockers, [], 'a clear is not a notification');
  assert.equal(h.repo.rows.get(CH)!.notifiedAt!.toISOString(), stamped.toISOString());

  // {A} comes back: inside the gate nothing; after it a new stamp.
  h.state.findings = [A];
  h.clock.advance(10 * MIN);
  await h.svc.recheck(CH, 'sweep');
  h.clock.advance(10 * MIN);
  await h.svc.recheck(CH, 'sweep');
  assert.deepEqual(h.repo.rows.get(CH)!.notifiedBlockers, [], 'inside the gate');
  h.clock.advance(STAMP_GATE_MS);
  await h.svc.recheck(CH, 'sweep');
  assert.deepEqual(h.repo.rows.get(CH)!.notifiedBlockers, [A.key]);
  assert.ok(h.repo.rows.get(CH)!.notifiedAt!.getTime() > stamped.getTime() + STAMP_GATE_MS - 1, 'a new day: the card gets a new refId');
});

test('a recheck with no blocker clears the stored set at once and writes nothing when it is already empty', async () => {
  const h = harness();
  h.state.autoFix = false;
  h.repo.rows.set(CH, { channelKey: CH, findings: [], blockers: 1, warnings: 0, configHash: '', appliedHash: null, checkedAt: h.clock.now, notifiedAt: new Date(h.clock.now.getTime() - 2 * HOUR), notifiedBlockers: ['k1'] });
  h.state.findings = [mkF('dataset_low_fill', 'warn')];
  await h.svc.recheck(CH, 'owner');
  assert.deepEqual(h.repo.upserts.at(-1)!.notifiedBlockers, []);
  assert.equal(h.repo.upserts.at(-1)!.notifiedAt, undefined, 'notified_at is not touched');
  await h.svc.recheck(CH, 'owner');
  assert.equal(h.repo.upserts.at(-1)!.notifiedBlockers, undefined, 'already empty: nothing to write');
});

test('a view neither stamps nor clears', async () => {
  const h = harness();
  h.state.autoFix = false;
  h.repo.rows.set(CH, { channelKey: CH, findings: [], blockers: 1, warnings: 0, configHash: '', appliedHash: null, checkedAt: h.clock.now, notifiedAt: null, notifiedBlockers: ['k1'] });
  h.state.findings = [];
  await h.svc.recheck(CH, 'view');
  assert.deepEqual(h.repo.rows.get(CH)!.notifiedBlockers, ['k1']);
});

// ── A20: auto_fixed rows ──────────────────────────────────────────────────────────────────────────────────────────

test('A20: an auto_fixed row is kept through two rechecks, counts toward nothing, and is gone after 25 hours', async () => {
  const h = harness();
  seeded(h);
  await h.svc.recheck(CH, 'sweep');
  const first = h.repo.rows.get(CH)!.findings.filter((f) => f.check === 'auto_fixed');
  assert.equal(first.length, 1);
  assert.equal(first[0].severity, 'info');
  assert.match(first[0].subject.id, new RegExp(`^hashtag_min_zero:${CH}:${Math.floor(h.clock.now.getTime() / 60_000)}$`));
  assert.equal(first[0].firstSeenAt, h.clock.now.toISOString());

  h.clock.advance(HOUR);
  await h.svc.recheck(CH, 'view');
  h.clock.advance(HOUR);
  const view = await h.svc.recheck(CH, 'view');
  const kept = h.repo.rows.get(CH)!.findings.filter((f) => f.check === 'auto_fixed');
  assert.deepEqual(kept.map((f) => f.key), first.map((f) => f.key), 'the same row, not a new one');
  assert.equal(view.infos, 0, 'an auto_fixed row is in no total');
  assert.equal(view.blockers, 1);
  assert.equal(h.repo.rows.get(CH)!.blockers, 1);
  assert.ok(view.findings.some((f) => f.code === 'auto_fixed'), 'the list still carries it, for the "Fixed by code" part');

  h.clock.advance(25 * HOUR);
  await h.svc.recheck(CH, 'view');
  assert.equal(h.repo.rows.get(CH)!.findings.filter((f) => f.check === 'auto_fixed').length, 0);
});

test('A20: the same fix applied twice gives two rows', async () => {
  const h = harness();
  h.onFix.current = () => undefined;
  h.state.findings = [autoFinding()];
  await h.svc.recheck(CH, 'sweep');
  h.clock.advance(5 * MIN);
  await h.svc.recheck(CH, 'sweep');
  const rows = h.repo.rows.get(CH)!.findings.filter((f) => f.check === 'auto_fixed');
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].subject.id, rows[1].subject.id);
});

// ── hooks ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('a hook gets the full event on every recheck: reason, both hashes, the applied hash, the facts and the stored findings', async () => {
  const h = harness();
  seeded(h);
  const events: RecheckEvent[] = [];
  h.svc.afterRecheck((e) => { events.push(e); });
  await h.svc.recheck(CH, 'sweep');
  await h.svc.recheck(CH, 'view');
  assert.equal(events.length, 2, 'every recheck, whether the hash changed or not');
  const [e1, e2] = events;
  assert.deepEqual(Object.keys(e1).sort(), ['appliedHash', 'channelKey', 'facts', 'findings', 'hash', 'prevHash', 'reason']);
  assert.equal(e1.reason, 'sweep');
  assert.equal(e1.channelKey, CH);
  assert.equal(e1.prevHash, 'old-hash');
  assert.match(e1.hash, /^[0-9a-f]{64}$/);
  assert.equal(e1.appliedHash, 'applied-by-074');
  assert.equal(e1.facts.channelKey, CH);
  assert.deepEqual(e1.findings.map((f) => f.check).sort(), ['auto_fixed', 'series_source_contradicted']);
  assert.equal(e2.prevHash, e1.hash, 'the next recheck sees the hash this one stored');
  assert.equal(e2.reason, 'view');
});

test('a hook that throws is logged and skipped; the others still run; unsubscribe takes a hook off', async () => {
  const h = harness();
  h.state.autoFix = false;
  const order: string[] = [];
  h.svc.afterRecheck(() => { order.push('a'); });
  h.svc.afterRecheck(() => { throw new Error('boom'); });
  const off = h.svc.afterRecheck(async () => { order.push('c'); });
  const view = await h.svc.recheck(CH, 'view');
  assert.deepEqual(order, ['a', 'c']);
  assert.ok(view, 'the recheck itself is not lost');
  assert.ok(h.calls.logs.some((l) => /a hook failed after view of @fx072: boom/.test(l)));
  off();
  await h.svc.recheck(CH, 'view');
  assert.deepEqual(order, ['a', 'c', 'a']);
});

test('a hook may start another recheck of the same channel (it runs after the lock is released)', async () => {
  const h = harness();
  h.state.autoFix = false;
  let inner: Promise<unknown> | null = null;
  h.svc.afterRecheck((e) => { if (e.reason === 'sweep') inner = h.svc.recheck(CH, 'config_skip'); });
  await h.svc.recheck(CH, 'sweep');
  await Promise.race([inner, new Promise((_, rej) => setTimeout(() => rej(new Error('deadlock')), 500))]);
  assert.equal(h.calls.load, 2);
});

// ── view, current, sweep ──────────────────────────────────────────────────────────────────────────────────────────

test('view() is built from the stored row and one slots query; it loads no facts, fixes nothing and stamps nothing', async () => {
  const h = harness();
  seeded(h);
  h.state.slots = [
    { status: 'published', error: null, verdict: null }, { status: 'awaiting_approval', error: null, verdict: null },
    { status: 'skipped', error: 'critic_rejected: too long', verdict: 'reject' }, { status: 'skipped', error: 'superseded by a new plan', verdict: null },
    { status: 'skipped', error: 'no_fresh_item: nothing new', verdict: null },
  ];
  const v = (await h.svc.view('@FX072'))!;
  assert.equal(h.calls.load, 0);
  assert.equal(h.calls.doctor, 0);
  assert.equal(h.calls.hashtag.length, 0);
  assert.equal(h.repo.upserts.length, 0);
  assert.equal(v.channelKey, CH);
  assert.equal(v.agent, 'fx072');
  assert.equal(v.mode, 'approve');
  assert.equal(v.blockers, 1);
  assert.deepEqual(v.last24h, { planned: 4, published: 1, awaiting: 1, skipped: 2, byGroup: { critic: 1, nothing_fresh: 1 } });
  assert.equal(v.topFix?.key, blockerB().key, 'the first blocker, there is no fix');
  assert.equal(await harness().svc.view(CH), null, 'no row yet');
});

test('GET: a row 30 seconds old is returned without loading facts; an older one or ?fresh=1 is one view recheck', async () => {
  const h = harness();
  h.state.autoFix = false;
  h.repo.rows.set(CH, { channelKey: CH, findings: [blockerB()], blockers: 1, warnings: 0, configHash: 'h', appliedHash: null, checkedAt: new Date(h.clock.now.getTime() - 30_000), notifiedAt: null, notifiedBlockers: [] });
  const v = await h.svc.current(CH);
  assert.equal(h.calls.load, 0);
  assert.equal(v.configHash, 'h');
  await h.svc.current(CH, { fresh: true });
  assert.equal(h.calls.load, 1, 'fresh skips the window');
  h.clock.advance(VIEW_WINDOW_MS + 1);
  await h.svc.current(CH);
  assert.equal(h.calls.load, 2, 'older than 60 s');
  assert.equal(h.repo.upserts.every((w) => w.notifiedBlockers === undefined && w.notifiedAt === undefined), true, 'a view stamps nothing');
});

test('sweep: one recheck per channel of the set, one at a time; a failing channel does not stop the rest', async () => {
  const h = harness();
  h.state.autoFix = false;
  h.repo.sweep = new Set(['@b', '@a', '@c']);
  const order: string[] = [];
  let busy = 0, maxBusy = 0;
  const base = h.svc as any;
  base.d.resolveKey = async (k: string) => k;
  base.d.load = async (k: string, now: Date) => {
    busy++; maxBusy = Math.max(maxBusy, busy);
    order.push(k);
    await new Promise((r) => setTimeout(r, 5));
    busy--;
    if (k === '@b') throw new Error('db down');
    return makeFacts({ now, channelKey: k });
  };
  const seen: string[] = [];
  h.svc.afterRecheck((e) => { seen.push(`${e.channelKey}:${e.reason}`); });
  const r = await h.svc.sweep();
  assert.deepEqual(order, ['@a', '@b', '@c']);
  assert.equal(maxBusy, 1);
  assert.deepEqual(r, { checked: 2, failed: 1 });
  assert.deepEqual(seen, ['@a:sweep', '@c:sweep']);
  assert.ok(h.calls.logs.some((l) => /sweep of @b failed: db down/.test(l)));
});

// ── fix ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const SKILL: Fix = { kind: 'skill_disable', agent: 'fx072', skill: 'old-skill' };
const resume = (id: string): Fix => ({ kind: 'series_resume', channel: CH, pauseId: id });

function withRow(h: Harness, findings: ReturnType<typeof mkF>[]) {
  h.state.autoFix = false;
  h.state.findings = findings;
  h.repo.rows.set(CH, { channelKey: CH, findings, blockers: 0, warnings: 0, configHash: 'x', appliedHash: null, checkedAt: h.clock.now, notifiedAt: null, notifiedBlockers: [] });
}

test('A13: fix() without a selection applies open errors and warnings with a fix, never an info finding\'s fix or an excluded kind', async () => {
  const h = harness();
  withRow(h, [
    mkF('series_source_contradicted', 'error', { id: 'e', fix: SKILL }),
    mkF('tools_missing_for_source', 'warn', { id: 'w', fix: { kind: 'tools_allow_add', channel: CH, tools: ['query_data'] } }),
    mkF('series_paused', 'info', { id: 'i', fix: resume('p-info') }),
    mkF('dataset_without_series', 'error', { id: 'x', fix: { kind: 'bind_dataset', channel: CH } as unknown as Fix }),
    mkF('dataset_low_fill', 'warn', { id: 'n' }),
  ]);
  const out = await h.svc.fix(CH, {}, 'dashboard');
  assert.deepEqual(h.calls.skills, ['old-skill']);
  assert.deepEqual(h.calls.tools, [[CH, ['query_data']]]);
  assert.deepEqual(h.calls.resumed, [], 'the info row keeps its own button');
  assert.equal(out.applied.length, 2);
  assert.deepEqual(out.failed, []);
});

test('A13: keys applies those findings only; codes applies the open findings with that code, any severity', async () => {
  const h = harness();
  const rows = [
    mkF('series_paused', 'info', { id: 'p1', fix: resume('p1') }), mkF('series_paused', 'info', { id: 'p2', fix: resume('p2') }),
    mkF('pause_cause_gone', 'warn', { id: 'p3', fix: resume('p3') }),
  ];
  withRow(h, rows);
  const one = await h.svc.fix(CH, { keys: [rows[1].key] }, 'dashboard');
  assert.deepEqual(h.calls.resumed, ['p2'], 'one row\'s button never resumes every paused series');
  assert.equal(one.applied.length, 1);
  const byCode = await h.svc.fix(CH, { codes: ['series_paused'] }, 'telegram');
  assert.deepEqual(h.calls.resumed, ['p2', 'p1', 'p2'], 'both info rows of the code (the stored row is the one the owner looked at)');
  assert.equal(byCode.applied.length, 2);
});

test('A13: an empty selection applies nothing; a key that is gone is reported; the same fix twice is applied once', async () => {
  const h = harness();
  const a = mkF('series_paused', 'info', { id: 'a', fix: resume('same') });
  const b = mkF('pause_cause_gone', 'warn', { id: 'b', fix: resume('same') });
  withRow(h, [a, b]);
  assert.deepEqual((await h.svc.fix(CH, { keys: [] })).applied, []);
  assert.deepEqual((await h.svc.fix(CH, { codes: [] })).applied, []);
  const gone = await h.svc.fix(CH, { keys: ['no-such-key'] });
  assert.deepEqual(gone.failed.map((f) => f.code), ['finding_gone']);
  assert.equal(h.calls.resumed.length, 0);
  withRow(h, [a, b]);
  const both = await h.svc.fix(CH, { keys: [a.key, b.key] });
  assert.deepEqual(h.calls.resumed, ['same']);
  assert.equal(both.applied.length, 1);
});

test('fix(): a refused fix is a failed entry with the finding\'s code, the others still apply, and the recheck is a fix recheck without auto-fix', async () => {
  const h = harness({ fixes: { patchSkill: async () => { throw Object.assign(new Error('x'), { response: { error: 'skill_not_found', details: 'old-skill' } }); } } });
  withRow(h, [mkF('series_source_contradicted', 'error', { id: 'e', fix: SKILL }), mkF('tools_missing_for_source', 'warn', { id: 'w', fix: { kind: 'tools_allow_add', channel: CH, tools: ['query_data'] } }), autoFinding()]);
  h.state.autoFix = true;
  const reasons: string[] = [];
  h.svc.afterRecheck((e) => { reasons.push(e.reason); });
  const out = await h.svc.fix(CH, { keys: [h.state.findings[0].key, h.state.findings[1].key] });
  assert.deepEqual(out.failed, [{ code: 'series_source_contradicted', error: 'skill_not_found: old-skill' }]);
  assert.equal(out.applied.length, 1);
  assert.deepEqual(reasons, ['fix']);
  assert.equal(h.calls.hashtag.length, 0, 'a fix recheck does not auto-fix (A10)');
  assert.equal(h.calls.load, 1);
  assert.equal(out.view.channelKey, CH);
  assert.ok(h.calls.logs.some((l) => /dashboard fix of @fx072: 1 applied, 1 failed/.test(l)));
});

test('fix() on a channel with no stored row looks first, then applies', async () => {
  const h = harness();
  h.state.autoFix = false;
  h.state.findings = [mkF('series_source_contradicted', 'error', { id: 'e', fix: SKILL })];
  const reasons: string[] = [];
  h.svc.afterRecheck((e) => { reasons.push(e.reason); });
  const out = await h.svc.fix(CH, {});
  assert.deepEqual(h.calls.skills, ['old-skill']);
  assert.equal(out.applied.length, 1);
  assert.deepEqual(reasons, ['view', 'fix']);
});

// ── lock, keys ────────────────────────────────────────────────────────────────────────────────────────────────────

test('the lock: two rechecks of one channel never overlap, and a failed one does not block the next', async () => {
  let busy = 0, maxBusy = 0, calls = 0;
  const h = harness({
    deps: {
      load: async (_k, now) => {
        calls++;
        busy++; maxBusy = Math.max(maxBusy, busy);
        await new Promise((r) => setTimeout(r, 10));
        busy--;
        if (calls === 1) throw new Error('first fails');
        return makeFacts({ now });
      },
    },
  });
  h.state.autoFix = false;
  const first = h.svc.recheck(CH, 'view');
  const second = h.svc.recheck(CH, 'sweep');
  const third = h.svc.fix(CH, {});
  await assert.rejects(first, /first fails/);
  await Promise.all([second, third]);
  assert.equal(maxBusy, 1);
});

test('A27: @X and @x are one channel: one stored row under the card\'s spelling; no card is channel_not_found', async () => {
  const h = harness();
  h.state.autoFix = false;
  await h.svc.recheck('@FX072', 'view');
  await h.svc.recheck('@fx072', 'view');
  await h.svc.recheck(` ${CH} `, 'view');
  assert.deepEqual([...h.repo.rows.keys()], [CH]);
  await assert.rejects(h.svc.recheck('@nobody', 'view'), (e: any) => e instanceof ChannelNotFound && e.code === 'channel_not_found');
  await assert.rejects(h.svc.current('@nobody'), ChannelNotFound);
  await assert.rejects(h.svc.fix('@nobody', {}), ChannelNotFound);
  await assert.rejects(h.svc.view('@nobody'), ChannelNotFound);
});
