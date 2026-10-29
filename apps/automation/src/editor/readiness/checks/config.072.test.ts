import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configConflicts } from '../../rules/config-conflicts';
import { findingKey } from '../../sysadmin/audit-text';
import { doctorReason } from '../codes';
import { makeFacts, mkPlaybook, mkSeries, REF } from '../testing/facts-fixture';
import { configCheck, configSeam, makeConfigCheck, type ConfigProblem, type ConfigSeam } from './config';

/** Spec 072 FR-003.4, FR-012, A8, A18, L8, I5: config_conflict, hashtag_min_without_vocabulary, formats_diverge and the 073 seam. */

const IG = 'instagram:ig1';
const run = (init: Parameters<typeof makeFacts>[0]) => configCheck.run(makeFacts(init));
const noHashtags = { id: 3, text: 'Без хештегів у постах' };
const section = (over: Record<string, unknown> = {}) => ({ resource_ref: REF, role: 'core', formats: { text: 1, poll: 0.3 }, per_day: { min: 1, max: 3 }, ...over });
const igSection = { resource_ref: IG, role: 'discovery', formats: { image: 1 }, per_day: { min: 0, max: 1 } };
const pb = (sec: Record<string, unknown> = {}, series: ReturnType<typeof mkSeries>[] = []) => mkPlaybook(series, { platforms: [section(sec), igSection] });

test('a healthy channel has no config finding', () => {
  assert.deepEqual(run({}), []);
  assert.deepEqual(run({ playbook: pb({ hashtag_policy: { min: 0, max: 0 } }) }), []);
});

// ── hashtag_min_without_vocabulary ──────────────────────────────────────────────────────────────────────────────────

test('a hashtag minimum with no hashtag list is an error with hashtag_min_zero, and not also a config_conflict', () => {
  const out = run({ card: { hashtagMin: 2, hashtags: [] } });
  assert.equal(out.length, 1);
  const x = out[0];
  assert.equal(x.check, 'hashtag_min_without_vocabulary');
  assert.equal(x.severity, 'error');
  assert.deepEqual(x.subject, { type: 'channel', id: '@fx072', label: 'Hashtag minimum', agent: 'fx072', channel: '@fx072' });
  assert.deepEqual(x.fix, { kind: 'hashtag_min_zero', channel: '@fx072' });
  assert.equal(x.link, '/app/editor/%40fx072');
  assert.deepEqual(x.evidence, { hashtag_min: 2, hashtags: 0 });
  assert.match(x.detail, /asks for at least 2 hashtags but has no hashtag vocabulary/);
});

test('no finding with a list, or with a minimum of 0', () => {
  assert.deepEqual(run({ card: { hashtagMin: 2, hashtags: ['ai'] } }), []);
  assert.deepEqual(run({ card: { hashtagMin: 0, hashtags: [] } }), []);
});

// ── config_conflict ─────────────────────────────────────────────────────────────────────────────────────────────────

test('an owner rule against the playbook is a warning with a conflicts_resolve fix for this code and this channel', () => {
  const out = run({ playbook: pb({ hashtag_policy: { min: 3, max: 5 } }), conflictBase: { rules: [noHashtags] } });
  const x = out.find((f) => f.check === 'config_conflict')!;
  assert.equal(x.severity, 'warn');
  assert.deepEqual(x.subject, { type: 'rule', id: 'hashtags_off_playbook:telegram:@fx072:3', label: 'Hashtags off playbook (rule #3)', agent: 'fx072', channel: '@fx072' });
  assert.deepEqual(x.fix, { kind: 'conflicts_resolve', agent: 'fx072', codes: ['hashtags_off_playbook'], channel: '@fx072' });
  assert.equal(x.link, '/app/agents/fx072?tab=memory');
  assert.equal((x.evidence as any).conflict, 'hashtags_off_playbook');
  assert.equal((x.evidence as any).rule_id, 3);
  assert.match(x.detail, /Playbook asks for 3–5 hashtags.*owner rule #3/);
});

test('a conflict without a rule is a channel subject', () => {
  const out = run({ playbook: pb({ tone: 'Дружньо, легкий сленг, з гумором.' }) });
  const x = out.find((f) => f.check === 'config_conflict')!;
  assert.equal(x.subject.type, 'channel');
  assert.equal(x.subject.id, 'slang_in_tone:telegram:@fx072:');
  assert.equal((x.evidence as any).conflict, 'slang_in_tone');
});

test('two conflicts of different codes are two findings with different keys', () => {
  const out = run({ playbook: pb({ hashtag_policy: { min: 3, max: 5 }, tone: 'Дружньо, легкий сленг.' }), conflictBase: { rules: [noHashtags] } })
    .filter((f) => f.check === 'config_conflict');
  assert.deepEqual(out.map((f) => (f.evidence as any).conflict).sort(), ['hashtags_off_playbook', 'slang_in_tone']);
  assert.notEqual(out[0].key, out[1].key);
  for (const f of out) assert.deepEqual((f.fix as any).codes, [(f.evidence as any).conflict]);
});

test('the same code twice for one rule is one finding that keeps both details', () => {
  const profile = { topic: 'Space', language: 'uk', formatPrefs: {}, full: { tone: 'Тепло, легкий сленг', audience: { who: 'x' } } as never };
  const out = run({ playbook: pb({ tone: 'Дружньо, легкий сленг.' }), profile }).filter((f) => f.check === 'config_conflict');
  assert.equal(out.length, 1);
  assert.equal((out[0].evidence as any).details.length, 2);
  assert.equal((out[0].evidence as any).fixes.length, 2);
});

test('a poll series over the weekly cap is no finding: 073 exempts series polls (S5, the code is gone)', () => {
  const series = [mkSeries({ name: 'Polls', cadence: 'daily@09:00', format: 'poll', brief: 'A poll of the day for the readers' })];
  const out = run({ card: { pollsPerWeek: 1 }, playbook: pb({}, series) });
  assert.deepEqual(out.filter((f) => f.check === 'config_conflict'), []);
});

test('without an agent there is no fix to run', () => {
  const f = makeFacts({ playbook: pb({ hashtag_policy: { min: 3, max: 5 } }), conflictBase: { rules: [noHashtags] } });
  const [x] = configCheck.run({ ...f, agent: null });
  assert.equal(x.fix, undefined);
  assert.equal(x.link, undefined, 'the Memory tab needs the agent');
});

test('two resources of one group: only this channel\'s conflict is a finding (A18)', () => {
  const f = makeFacts({
    playbook: mkPlaybook([], { platforms: [section({ hashtag_policy: { min: 0, max: 0 } }), { ...igSection, hashtag_policy: { min: 2, max: 4 } }] }),
    conflictBase: { rules: [noHashtags], refs: [REF, IG] },
  });
  const all = configConflicts(f.conflictInput);
  assert.ok(all.some((c) => c.ref === IG && c.code === 'hashtags_off_playbook'), 'control: the group has a conflict on the sibling');
  assert.deepEqual(configCheck.run(f), []);
  // The sibling's own panel would show it: the same facts anchored on the other resource.
  const sib = configCheck.run({ ...f, resourceRef: IG });
  assert.equal(sib.length, 1);
  assert.equal((sib[0].evidence as any).ref, IG);
});

// ── formats_diverge ─────────────────────────────────────────────────────────────────────────────────────────────────

const group = (mode: string) => ({ id: 'g1', name: 'Space', mode });

test('in an independent group a card format missing from the playbook section is a warning without a fix', () => {
  const out = run({ group: group('independent'), card: { formats: { text: 1, poll: 0.3 } }, playbook: pb({ formats: { text: 1 } }) });
  assert.equal(out.length, 1);
  const x = out[0];
  assert.equal(x.check, 'formats_diverge');
  assert.equal(x.severity, 'warn');
  assert.deepEqual(x.subject, { type: 'playbook', id: 'poll', label: 'poll', agent: 'fx072', channel: '@fx072' });
  assert.equal(x.fix, undefined);
  assert.equal(x.link, '/app/agents/fx072?tab=playbook');
  assert.match(x.detail, /The card enables the format poll \(weight 0\.3\)/);
});

test('the reverse, and a weight of 0 against a missing format', () => {
  const rev = run({ group: group('independent'), card: { formats: { text: 1 } }, playbook: pb({ formats: { text: 1, quiz: 0.5 } }) });
  assert.equal(rev.length, 1);
  assert.equal(rev[0].subject.id, 'quiz');
  assert.match(rev[0].detail, /playbook section of telegram:@fx072 enables the format quiz/);
  assert.deepEqual(run({ group: group('independent'), card: { formats: { text: 1, poll: 0 } }, playbook: pb({ formats: { text: 1 } }) }), []);
  assert.deepEqual(run({ group: group('independent'), card: { formats: { text: 1 } }, playbook: pb({ formats: { text: 1, poll: 0 } }) }), []);
});

test('two diverging formats are two findings', () => {
  const out = run({ group: group('independent'), card: { formats: { text: 1, poll: 1 } }, playbook: pb({ formats: { text: 1, quiz: 1 } }) });
  assert.deepEqual(out.map((f) => f.subject.id).sort(), ['poll', 'quiz']);
  assert.notEqual(out[0].key, out[1].key);
});

test('other groups, no group and no playbook section are left alone', () => {
  const init = { card: { formats: { text: 1, poll: 1 } }, playbook: pb({ formats: { text: 1 } }) };
  assert.deepEqual(run({ ...init, group: group('legacy_duplicate') }), []);
  assert.deepEqual(run({ ...init, group: group('network') }), []);
  assert.deepEqual(run({ ...init, group: null }), []);
  assert.deepEqual(run({ group: group('independent'), card: { formats: { poll: 1 } }, playbook: mkPlaybook([], { platforms: [igSection] }) }), []);
  assert.deepEqual(run({ group: group('independent'), card: { formats: { poll: 1 } }, playbook: null }), []);
});

// ── the 073 seam ────────────────────────────────────────────────────────────────────────────────────────────────────

// The real seam (073 × 072 merge, S4): 073's checkPlanSkeleton and checkSlotConfig, 073's isRepairable.

/** Facts whose resource carries what the loader fills through `skeletonResourcesOf` (formats, zone, quiet hours). */
const withFormats = (init: Parameters<typeof makeFacts>[0], formats = ['text', 'photo', 'poll']) => {
  const f = makeFacts(init);
  return { ...f, resources: [{ ref: REF, platform: 'telegram', formats, tz: 'Europe/Kyiv', quiet: { start: 23, end: 8 } }] };
};

test('real seam: a series inside the quiet hours is an error from 073 (series_in_quiet_hours), titled by the catalogue', () => {
  const f = withFormats({ playbook: pb({}, [mkSeries({ name: 'Night', cadence: 'daily@02:00' })]) });
  const x = configCheck.run(f).find((y) => y.check === 'series_in_quiet_hours')!;
  assert.ok(x);
  assert.equal(x.severity, 'error');
  assert.equal(x.title, doctorReason('series_in_quiet_hours')!.en);
  assert.equal(x.subject.label, 'Night');
  assert.match(x.detail, /02:00, inside the quiet hours 23:00-8:00/);
});

test('real seam: a format the resource cannot produce is series_format_unavailable; no formats from the loader, no check', () => {
  const init = { playbook: pb({}, [mkSeries({ name: 'Photo', cadence: 'daily@12:00', format: 'photo' })]) };
  const x = configCheck.run(withFormats(init, ['text'])).find((y) => y.check === 'series_format_unavailable')!;
  assert.equal(x.severity, 'error');
  assert.equal(x.subject.label, 'Photo');
  assert.deepEqual(configCheck.run(makeFacts(init)).filter((y) => y.check === 'series_format_unavailable'), [], 'a resource without formats is left out');
});

test('real seam: more series posts a day than the card maximum is a warning (series_rate_over_card_max)', () => {
  const series = [mkSeries({ name: 'Morning', cadence: 'daily@10:00,12:00' }), mkSeries({ name: 'Evening', cadence: 'daily@15:00' })];
  const x = configCheck.run(withFormats({ card: { postsPerDayMax: 2 }, playbook: pb({}, series) })).find((y) => y.check === 'series_rate_over_card_max')!;
  assert.equal(x.severity, 'warn');
  assert.match(x.detail, /3 series posts on .*more than the card's maximum of 2/);
  assert.deepEqual(configCheck.run(withFormats({ card: { postsPerDayMax: 3 }, playbook: pb({}, series) })).filter((y) => y.check === 'series_rate_over_card_max'), []);
});

const ctxSeries = [{ name: 'Prompt', resource_ref: REF, format: 'photo', active: true, source: { kind: 'library' as const, table: 'prompts' }, source_mode: 'required' as const }];
const planned = (over: Record<string, unknown> = {}) => ({
  id: 'slot-1', scheduledAt: '2026-10-27T10:00:00.000Z', resourceRef: REF, format: 'photo', seriesName: 'Prompt', sourceHints: [], scheduleRuleId: null,
  configCtx: { series: ctxSeries, catalog: null, tools: null }, ...over,
});

test('real seam: a slot whose format drifted is info, repaired before the run; a slot without a context is not checked', () => {
  const out = configCheck.run(makeFacts({ planned: [planned({ format: 'text' }), planned({ id: 'slot-2', format: 'text', configCtx: undefined })] }));
  assert.deepEqual(out.map((x) => [x.check, x.severity, (x.evidence as any).slot]), [['config_format_mismatch', 'info', 'slot-1']]);
  assert.match(out[0].detail, /It will be repaired before the run\.$/);
  assert.equal(configSeam.isRepairable({ code: 'config_format_mismatch', detail: '' }), true);
  assert.equal(configSeam.isRepairable({ code: 'config_tools_missing', detail: '' }), false);
});

test('real seam: a gone series is info and costs nothing; preflight_no_material is left to the material check', () => {
  const gone = configCheck.run(makeFacts({ planned: [planned({ seriesName: 'Old' })] }));
  assert.deepEqual(gone.map((x) => [x.check, x.severity]), [['config_series_gone', 'info']]);
  assert.match(gone[0].detail, /The slot is skipped at no cost\.$/);
  const empty = configCheck.run(makeFacts({ planned: [planned({ configCtx: { series: ctxSeries, catalog: null, tools: null, material: 'empty' } })] }));
  assert.deepEqual(empty, []);
});

const stub = (over: Partial<ConfigSeam>): ConfigSeam => ({ planSkeleton: () => [], slotConfig: () => [], isRepairable: () => false, ...over });

test('a plan problem is an error with its own code, the Schedule tab, and the series in its subject (A8)', () => {
  const p: ConfigProblem = { code: 'plan_no_series', detail: 'The plan has no series for photo.', series: 'Prompt' };
  const f = makeFacts();
  const [x] = makeConfigCheck(stub({ planSkeleton: () => [p] })).run(f);
  assert.equal(x.check, 'plan_no_series');
  assert.equal(x.severity, 'error');
  assert.equal(x.area, 'channel');
  assert.deepEqual(x.subject, { type: 'channel', id: 'plan_no_series:Prompt:', label: 'Prompt', agent: 'fx072', channel: '@fx072' });
  assert.equal(x.key, findingKey('channel', 'plan_no_series', x.subject));
  assert.equal(x.detail, 'The plan has no series for photo.');
  assert.equal(x.title, 'Plan no series', 'a code that is not in the catalogue gets its own words as the title');
  assert.equal(x.link, '/app/agents/fx072?tab=schedule');
  assert.equal(x.fix, undefined);
});

test('a slot problem is keyed by the slot and the time; a repairable one is info and says it will be repaired', () => {
  const slot = { slotId: 'slot-1', problems: [
    { code: 'slot_tool_missing', detail: 'The slot needs query_data.', at: '09:00' },
    { code: 'slot_format_off', detail: 'The format is switched off.' },
  ] };
  const seam = stub({ slotConfig: () => [slot], isRepairable: (p) => p.code === 'slot_format_off' });
  const out = makeConfigCheck(seam).run(makeFacts());
  const hard = out.find((x) => x.check === 'slot_tool_missing')!;
  const soft = out.find((x) => x.check === 'slot_format_off')!;
  assert.equal(hard.severity, 'error');
  assert.equal(hard.subject.id, 'slot_tool_missing:slot-1:09:00');
  assert.equal((hard.evidence as any).slot, 'slot-1');
  assert.equal(soft.severity, 'info');
  assert.equal(soft.subject.id, 'slot_format_off:slot-1:');
  assert.match(soft.detail, /It will be repaired before the run\.$/);
  assert.notEqual(hard.key, soft.key);
});

test('two slots with the same problem are two findings', () => {
  const same = { code: 'slot_tool_missing', detail: 'd' };
  const seam = stub({ slotConfig: () => [{ slotId: 'a', problems: [same] }, { slotId: 'b', problems: [same] }] });
  const out = makeConfigCheck(seam).run(makeFacts());
  assert.equal(out.length, 2);
  assert.notEqual(out[0].key, out[1].key);
});

test('a seam code that is in the doctor catalogue takes its title from it', () => {
  const code = 'tools_missing_for_source';
  const [x] = makeConfigCheck(stub({ planSkeleton: () => [{ code, detail: 'd' }] })).run(makeFacts());
  assert.equal(x.title, doctorReason(code)!.en);
});

test('the same input always gives the same config findings and keys', () => {
  const init = { playbook: pb({ hashtag_policy: { min: 3, max: 5 } }), conflictBase: { rules: [noHashtags] }, card: { hashtagMin: 2, hashtags: [] } };
  const a = run(init).map((f) => f.key);
  assert.deepEqual(a, run(init).map((f) => f.key));
  assert.equal(a.length, 2);
});
