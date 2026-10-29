import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Fix } from '../sysadmin/audit.types';
import { fixLabel } from '../sysadmin/fix-runner';
import { FIX_ALL_EXCLUDED_KINDS } from './auto-fix';
import { CH } from './testing/facts-fixture';
import { mkF } from './testing/fake-readiness';
import { buildView, countFindings, isFixAllTarget, last24hOf, selectFixes, toReadinessFinding, topFixOf } from './view';

/** Spec 072 T6, FR-007, A13, A15, A20: the pure part of the stored view. */

const HASHTAG: Fix = { kind: 'hashtag_min_zero', channel: CH };
const SKILL: Fix = { kind: 'skill_disable', agent: 'fx072', skill: 's' };

test('toReadinessFinding keeps the Fix on the server: the view carries its label and whether code may apply it by itself', () => {
  const auto = toReadinessFinding(mkF('hashtag_min_without_vocabulary', 'error', { fix: HASHTAG }));
  assert.deepEqual(auto.fix, { label: fixLabel(HASHTAG), auto: true });
  const one = toReadinessFinding(mkF('series_source_contradicted', 'error', { fix: SKILL }));
  assert.deepEqual(one.fix, { label: fixLabel(SKILL), auto: false });
  const none = toReadinessFinding(mkF('dataset_low_fill', 'warn'));
  assert.equal(none.fix, null);
  assert.ok(!('evidence' in none) && !JSON.stringify(none).includes('"kind"'), 'no Fix object in the view');
  assert.equal(none.link, '/app/agents/fx072?tab=skills');
  assert.equal(none.firstSeenAt, null);
});

test('countFindings leaves the auto_fixed rows out of every total', () => {
  const c = countFindings([mkF('a', 'error'), mkF('b', 'error'), mkF('c', 'warn'), mkF('d', 'info'), mkF('auto_fixed', 'info', { id: 'x' })]);
  assert.deepEqual(c, { blockers: 2, warnings: 1, infos: 1 });
});

test('A13: Fix all covers open errors and warnings with a fix of a kind that is not excluded', () => {
  assert.equal(isFixAllTarget(mkF('a', 'error', { fix: SKILL })), true);
  assert.equal(isFixAllTarget(mkF('a', 'warn', { fix: SKILL })), true);
  assert.equal(isFixAllTarget(mkF('a', 'info', { fix: SKILL })), false, 'an info row keeps its own button');
  assert.equal(isFixAllTarget(mkF('a', 'error')), false, 'no fix');
  for (const kind of FIX_ALL_EXCLUDED_KINDS) assert.equal(isFixAllTarget(mkF('a', 'error', { fix: { kind } as unknown as Fix })), false, kind);
  assert.equal(isFixAllTarget(mkF('auto_fixed', 'warn', { fix: SKILL })), false);
});

test('topFix is the first blocker with a fix, else the first blocker, else null', () => {
  const noFix = mkF('a', 'error', { id: '1' });
  const withFix = mkF('b', 'error', { id: '2', fix: SKILL });
  assert.equal(topFixOf([noFix, withFix])?.key, withFix.key);
  assert.equal(topFixOf([noFix, mkF('c', 'error', { id: '3' })])?.key, noFix.key);
  assert.equal(topFixOf([mkF('w', 'warn', { fix: SKILL })]), null);
  assert.deepEqual(topFixOf([withFix]), { key: withFix.key, title: withFix.title, link: withFix.link });
});

test('A15: last24h counts planned, published, awaiting and skipped; the skips the owner or the system chose are not planned', () => {
  const rows = [
    { status: 'published', error: null, verdict: null }, { status: 'published', error: null, verdict: null },
    { status: 'shadowed', error: null, verdict: null },
    { status: 'awaiting_approval', error: null, verdict: null }, { status: 'approved', error: null, verdict: null },
    { status: 'skipped', error: 'critic_rejected: dull', verdict: 'reject' },
    { status: 'skipped', error: 'skipped by agent: no angle', verdict: 'revise' },
    { status: 'failed', error: 'budget_exceeded: channel', verdict: null },
    { status: 'expired', error: 'something else', verdict: null },
    { status: 'skipped', error: 'superseded by a new plan', verdict: null },
    { status: 'skipped', error: 'series_paused: Daily tip', verdict: null },
    { status: 'planned', error: null, verdict: null },
  ];
  assert.deepEqual(last24hOf(rows), { planned: 9, published: 2, awaiting: 2, skipped: 4, byGroup: { critic: 2, budget: 1, other: 1 } });
  assert.deepEqual(last24hOf([]), { planned: 0, published: 0, awaiting: 0, skipped: 0, byGroup: {} });
});

test('buildView: the counts, fixable, the findings without their Fix, and the stored time as ISO', () => {
  const findings = [
    mkF('a', 'error', { id: '1', fix: SKILL }), mkF('b', 'error', { id: '2', fix: { kind: 'bind_dataset' } as unknown as Fix }), mkF('c', 'warn', { fix: HASHTAG }),
    mkF('d', 'info', { fix: SKILL }), mkF('auto_fixed', 'info', { id: 'z' }),
  ];
  const v = buildView({ channelKey: CH, findings, configHash: 'h', checkedAt: new Date('2026-10-20T10:00:00.000Z') }, { mode: 'live', agent: 'fx072' }, []);
  assert.equal(v.checkedAt, '2026-10-20T10:00:00.000Z');
  assert.deepEqual([v.blockers, v.warnings, v.infos, v.fixable], [2, 1, 1, 2]);
  assert.equal(v.findings.length, 5);
  assert.equal(v.mode, 'live');
  assert.equal(v.agent, 'fx072');
  assert.equal(v.topFix?.key, findings[0].key);
});

test('A13 selectFixes: no field = Fix all; codes and keys narrow it; both = the findings that match both', () => {
  const e = mkF('a', 'error', { id: '1', fix: SKILL });
  const w = mkF('b', 'warn', { id: '2', fix: SKILL });
  const i = mkF('c', 'info', { id: '3', fix: SKILL });
  const x = mkF('d', 'error', { id: '4', fix: { kind: 'dataset_patch' } as unknown as Fix });
  const all = [e, w, i, x, mkF('auto_fixed', 'info', { id: '5', fix: SKILL }), mkF('f', 'warn', { id: '6' })];
  assert.deepEqual(selectFixes(all, {}).picked, [e, w]);
  assert.deepEqual(selectFixes(all, { codes: ['c'] }).picked, [i], 'any severity');
  assert.deepEqual(selectFixes(all, { codes: ['d'] }).picked, [x], 'a code names the exclusion list\'s kind on purpose');
  assert.deepEqual(selectFixes(all, { keys: [w.key, i.key] }).picked, [w, i]);
  assert.deepEqual(selectFixes(all, { keys: [w.key, i.key], codes: ['c'] }).picked, [i]);
  assert.deepEqual(selectFixes(all, { keys: [] }), { picked: [], missing: [] });
  assert.deepEqual(selectFixes(all, { codes: [] }).picked, []);
  assert.deepEqual(selectFixes(all, { keys: ['nope'] }), { picked: [], missing: ['nope'] });
  assert.deepEqual(selectFixes(all, { keys: [all[5].key] }).missing, [all[5].key], 'a finding without a fix has nothing to apply');
});
