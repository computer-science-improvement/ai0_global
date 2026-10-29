import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_FAILURE_CODES, isConfigCode } from '../readiness/slot-config';
import { SKIP_GROUPS, isContentFailureCode, isNotAMiss, isOwnerDecision, skipGroupOf } from './skip-reasons';
import { classifyClose } from '../series-pause/skip-cause';
import { shouldPassRow } from './fallback-ladder';
import { ideaOutcomeOf } from '../network/idea-outcome';
import { channelLines } from '../owner-bot/owner-reports';
import { evaluateSilentDays, type WatchSlot } from './silent-days';

/** Spec 073 FR-010 (A5, A6, A9, A31, A36, A51, L4, L7): the skip class `config` in every consumer. */

test('the list: ten codes, one source (CONFIG_FAILURE_CODES / isConfigCode), and `config` is a skip group', () => {
  assert.equal(CONFIG_FAILURE_CODES.length, 10);
  assert.ok((SKIP_GROUPS as readonly string[]).includes('config'));
  for (const c of CONFIG_FAILURE_CODES) assert.equal(isConfigCode(c), true, c);
  for (const c of ['preflight_no_material', 'preflight_host_blocked', 'planner_no_material', 'lint_failed', 'series_rate_over_card_max', '', null, undefined]) {
    assert.equal(isConfigCode(c), false, String(c));
  }
});

test('skipGroupOf is `config` for every listed code, and none of them is a content failure any more', () => {
  for (const c of CONFIG_FAILURE_CODES) {
    assert.equal(skipGroupOf(`${c}: x`), 'config', c);
    assert.equal(skipGroupOf(c), 'config', `${c} bare`);
    assert.equal(isContentFailureCode(c), false, `${c} is not a content failure`);
  }
  // series_source_mismatch left the lint group; the material codes did not move (L4, L7).
  assert.equal(skipGroupOf('series_source_mismatch: the post cites another dataset'), 'config');
  assert.equal(skipGroupOf('preflight_no_material: row not found'), 'nothing_fresh');
  assert.equal(skipGroupOf('preflight_host_blocked: x'), 'nothing_fresh');
  assert.equal(skipGroupOf('preflight_format_unavailable: carousel needs hosting'), 'config');
  assert.equal(skipGroupOf('lint_failed: caption_too_long'), 'lint');
});

test('classifyClose is `ignore` for each config code (series_format_unavailable and series_in_quiet_hours included), skipped or failed', () => {
  for (const c of CONFIG_FAILURE_CODES) {
    assert.deepEqual(classifyClose({ status: 'skipped', error: `${c}: x` }), { k: 'ignore' }, c);
    assert.deepEqual(classifyClose({ status: 'failed', error: `${c}: x` }), { k: 'ignore' }, `${c} failed`);
  }
  // The material codes keep counting toward the 060 breaker.
  assert.deepEqual(classifyClose({ status: 'skipped', error: 'preflight_no_material: row not found' }), { k: 'cause', cause: 'no_material' });
  assert.deepEqual(classifyClose({ status: 'skipped', error: 'preflight_host_blocked: x' }), { k: 'cause', cause: 'source_unreachable' });
});

test('shouldPassRow is false for each config code, where the same failure of another code puts the row aside', () => {
  const f = (code: string) => ({ kind: 'critic_reject' as const, code, fixable: false, libraryRef: 'data://prompts/503' });
  assert.equal(shouldPassRow(f('critic_rejected'), 'revise_source'), true, 'control');
  for (const c of CONFIG_FAILURE_CODES) assert.equal(shouldPassRow(f(c), 'revise_source'), false, c);
});

test('config_series_gone is not a miss (the owner removed or paused the series); the other config codes are', () => {
  assert.equal(isNotAMiss('config_series_gone: series "Prompt" is switched off'), true);
  assert.equal(isOwnerDecision('config_series_gone: x'), false);
  for (const c of CONFIG_FAILURE_CODES.filter((x) => x !== 'config_series_gone')) assert.equal(isNotAMiss(`${c}: x`), false, c);
});

test('ideaOutcomeOf: a config skip returns the idea to the pool', () => {
  for (const e of ['config_format_mismatch: x', 'series_source_mismatch: x', 'config_source_missing: x', 'series_in_quiet_hours: x']) {
    assert.equal(ideaOutcomeOf('skipped', e).status, 'accepted', e);
  }
  assert.equal(ideaOutcomeOf('skipped', 'lint_failed: x').status, 'used', 'a content failure still uses the idea');
});

test('the owner report names the group «налаштування»', async () => {
  const rows = [
    { ref: 'telegram:@a', channel_key: '@a', title: 'A', status: 'skipped', error: 'config_format_mismatch: text → quiz', verdict: null },
    { ref: 'telegram:@a', channel_key: '@a', title: 'A', status: 'skipped', error: 'series_source_mismatch: x', verdict: null },
    { ref: 'telegram:@a', channel_key: '@a', title: 'A', status: 'skipped', error: 'daily_cap_reached: x', verdict: null },
  ];
  const pool = { query: async (sql: string) => ({ rows: /status IN \('published'/.test(sql) ? rows : [] }) };
  const lines = await channelLines(pool as any, new Date('2026-10-20T21:00:00Z'), new Date('2026-10-21T21:00:00Z'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].skipped, 3);
  assert.equal(lines[0].skipWhy, 'налаштування');
});

const REF = 'telegram:@prompts';
const TZ = 'Europe/Kyiv';
let n = 0;
const slot = (at: string, error: string, over: Partial<WatchSlot> = {}): WatchSlot => ({
  id: `c${++n}`, ref: REF, scheduledAt: new Date(at), updatedAt: new Date(at), status: 'skipped', error, format: 'quiz', topic: 'Тема',
  seriesName: 'Prompt', scheduleRuleId: null, criticVerdict: null, fallback: null, ...over,
});
const alerts = (slots: WatchSlot[], now: string) => evaluateSilentDays({ now: new Date(now), resources: [{ ref: REF, tz: TZ, minPerDay: 0 }], slots });

test('the silent-day note labels the group, and two days of a config close make the series stalled', () => {
  const dark = alerts([slot('2026-10-12T07:00:00Z', 'config_format_mismatch: text → quiz')], '2026-10-12T16:00:00Z').find((a) => a.kind === 'dark_day')!;
  assert.match(dark.alert.body, /причини: налаштування/);
  assert.match(dark.body, /config 1/);
  const note = alerts([slot('2026-10-11T07:00:00Z', 'series_source_mismatch: x'), slot('2026-10-12T07:00:00Z', 'config_format_mismatch: text → quiz')], '2026-10-12T10:00:00Z')
    .find((a) => a.kind === 'series_missed' && a.day === '2026-10-12')!;
  assert.deepEqual(note.parts.filter((p) => p.startsWith('stalled:')), ['stalled:Prompt']);
  assert.match(note.body, /two days in a row: Slot format differs from the series format/);
  // config_series_gone is not a miss: it neither makes a note nor a stalled series.
  const gone = alerts([slot('2026-10-11T07:00:00Z', 'config_series_gone: x'), slot('2026-10-12T07:00:00Z', 'config_series_gone: x')], '2026-10-12T10:00:00Z');
  assert.equal(gone.filter((a) => a.kind === 'series_missed').length, 0);
});
