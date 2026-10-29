import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIX_KINDS, FINDING_AREAS, AUDIT_AREAS, type Fix } from './audit.types';
import { describeFix, fixLabel, mergeToolsAllow, runFix, tryFix, type FixPorts } from './fix-runner';
import { applySeriesOp } from '../schedule/series-change';
import { PlaybookSchema } from '../network/playbook';

/** Spec 072 T1: the shared fix runner, the eight kinds, the ports they call and their refusals. */

const CYRILLIC = /[Ѐ-ӿ]/;

const ALL_FIXES: Fix[] = [
  { kind: 'skill_disable', agent: 'a', skill: 's' },
  { kind: 'skill_inline_off', agent: 'a', skill: 's' },
  { kind: 'memory_retire', channel: '@c', id: 7 },
  { kind: 'conflicts_resolve', agent: 'a' },
  { kind: 'conflicts_resolve', agent: 'a', codes: ['hashtags_off_playbook'], channel: '@c' },
  { kind: 'tools_allow_add', channel: '@c', tools: ['query_data'] },
  { kind: 'hashtag_min_zero', channel: '@c' },
  { kind: 'series_resume', channel: '@c', pauseId: 'p1' },
  { kind: 'series_source_require', channel: '@c', series: 'Prompt' },
];

function ports(over: Partial<FixPorts> = {}) {
  const calls: any[][] = [];
  const p: FixPorts = {
    agentByHandle: async (h) => ({ id: 'a1', handle: h } as any),
    patchSkill: async (...a) => { calls.push(['patchSkill', ...a]); },
    retireMemory: async (...a) => { calls.push(['retireMemory', ...a]); return true; },
    applyConflicts: async (...a) => { calls.push(['applyConflicts', ...a.slice(1)]); return { applied: ['x'], remaining: [] }; },
    addCardTools: async (...a) => { calls.push(['addCardTools', ...a]); },
    setHashtagMin: async (...a) => { calls.push(['setHashtagMin', ...a]); },
    seriesPause: async () => ({ cause: 'no_material', resumed: false }),
    resumeSeriesPause: async (...a) => { calls.push(['resumeSeriesPause', ...a]); },
    requireSeriesSource: async (...a) => { calls.push(['requireSeriesSource', ...a]); },
    ...over,
  };
  return { p, calls };
}

const refusalOf = async (fn: () => Promise<unknown>): Promise<{ error: string; details?: string }> => {
  try { await fn(); } catch (e: any) { return e.response; }
  return assert.fail('expected a refusal');
};

test('FIX_KINDS lists exactly the eight kinds; the weekly audit areas do not gain `channel`', () => {
  assert.deepEqual([...FIX_KINDS], [
    'skill_disable', 'skill_inline_off', 'memory_retire', 'conflicts_resolve',
    'tools_allow_add', 'hashtag_min_zero', 'series_resume', 'series_source_require',
  ]);
  assert.deepEqual([...AUDIT_AREAS], ['skills', 'memory', 'rules', 'tools', 'prompt']);
  assert.deepEqual([...FINDING_AREAS], [...AUDIT_AREAS, 'channel']);
});

test('every kind has a button label and a description, in English', () => {
  for (const f of ALL_FIXES) {
    assert.ok(fixLabel(f).length > 3, f.kind);
    assert.ok(describeFix(f).length > 3, f.kind);
    assert.doesNotMatch(fixLabel(f), CYRILLIC, f.kind);
    assert.doesNotMatch(describeFix(f, 'extra'), CYRILLIC, f.kind);
  }
  assert.equal(fixLabel({ kind: 'conflicts_resolve', agent: 'a', channel: '@c' }), 'Resolve for this channel');
  assert.match(fixLabel({ kind: 'series_source_require', channel: '@c', series: 'P' }), /yours.*locked/);
  assert.equal(new Set(ALL_FIXES.map((f) => f.kind)).size, FIX_KINDS.length);
});

test('each kind calls its port with the right arguments and answers { ok, applied }', async () => {
  const { p, calls } = ports();
  const run = (f: Fix) => runFix(p, f);
  assert.equal((await run({ kind: 'skill_disable', agent: 'news', skill: 'prompthero' })).applied, 'Skill prompthero switched off for @news');
  assert.equal((await run({ kind: 'skill_inline_off', agent: 'news', skill: 'big' })).ok, true);
  assert.equal((await run({ kind: 'memory_retire', channel: '@c', id: 7 })).applied, 'Memory row #7 of @c retired');
  assert.match((await run({ kind: 'tools_allow_add', channel: '@c', tools: ['query_data', 'fetch_feed'] })).applied!, /query_data, fetch_feed/);
  await run({ kind: 'hashtag_min_zero', channel: '@c' });
  await run({ kind: 'series_resume', channel: '@c', pauseId: 'p1' });
  await run({ kind: 'series_source_require', channel: '@c', series: 'Prompt' });
  assert.deepEqual(calls, [
    ['patchSkill', 'news', 'prompthero', { enabled: false }],
    ['patchSkill', 'news', 'big', { inline: false }],
    ['retireMemory', '@c', 7],
    ['addCardTools', '@c', ['query_data', 'fetch_feed']],
    ['setHashtagMin', '@c', 0],
    ['resumeSeriesPause', 'p1'],
    ['requireSeriesSource', '@c', 'Prompt'],
  ]);
});

test('a missing port refuses with fix_unavailable, for each new kind', async () => {
  const bare: FixPorts = { agentByHandle: async () => null, patchSkill: async () => undefined, retireMemory: async () => true, applyConflicts: async () => ({ applied: [], remaining: [] }) };
  const fresh = ALL_FIXES.filter((x) => ['tools_allow_add', 'hashtag_min_zero', 'series_resume', 'series_source_require'].includes(x.kind));
  assert.equal(fresh.length, 4);
  for (const f of fresh) assert.equal((await refusalOf(() => runFix(bare, f))).error, 'fix_unavailable', f.kind);
});

test('series_resume refuses an owner pause, a missing pause and a resumed one', async () => {
  const fix: Fix = { kind: 'series_resume', channel: '@c', pauseId: 'p1' };
  const owner = ports({ seriesPause: async () => ({ cause: 'owner', resumed: false }) });
  assert.equal((await refusalOf(() => runFix(owner.p, fix))).error, 'owner_pause');
  assert.equal(owner.calls.length, 0, 'the pause stays');
  assert.equal((await refusalOf(() => runFix(ports({ seriesPause: async () => null }).p, fix))).error, 'pause_not_found');
  assert.equal((await refusalOf(() => runFix(ports({ seriesPause: async () => ({ cause: 'no_material', resumed: true }) }).p, fix))).error, 'already_resumed');
  const r = await tryFix(owner.p, fix);
  assert.equal(r.ok, false);
  assert.match(r.error!, /^owner_pause: /);
});

test('conflicts_resolve: codes and channel become the port scope; without them the call is the weekly audit\'s', async () => {
  const { p, calls } = ports();
  await runFix(p, { kind: 'conflicts_resolve', agent: 'a' });
  await runFix(p, { kind: 'conflicts_resolve', agent: 'a', codes: ['slang_in_tone'] });
  await runFix(p, { kind: 'conflicts_resolve', agent: 'a', channel: '@c' });
  await runFix(p, { kind: 'conflicts_resolve', agent: 'a', codes: ['slang_in_tone'], channel: '@c' });
  assert.deepEqual(calls, [
    ['applyConflicts'],
    ['applyConflicts', { codes: ['slang_in_tone'] }],
    ['applyConflicts', { ref: 'telegram:@c' }],
    ['applyConflicts', { codes: ['slang_in_tone'], ref: 'telegram:@c' }],
  ]);
  const none = ports({ applyConflicts: async () => ({ applied: [], remaining: [] }) });
  assert.equal((await refusalOf(() => runFix(none.p, { kind: 'conflicts_resolve', agent: 'a' }))).error, 'nothing_to_apply');
  const gone = ports({ agentByHandle: async () => null });
  assert.equal((await refusalOf(() => runFix(gone.p, { kind: 'conflicts_resolve', agent: 'a' }))).error, 'agent_not_found');
});

test('tryFix never throws: a refusal and a plain error become { ok: false, error }', async () => {
  const boom = ports({ patchSkill: async () => { throw new Error('db down'); } });
  const r = await tryFix(boom.p, { kind: 'skill_disable', agent: 'a', skill: 's' });
  assert.deepEqual(r, { ok: false, error: 'db down' });
  const r2 = await tryFix(ports({ retireMemory: async () => false }).p, { kind: 'memory_retire', channel: '@c', id: 1 });
  assert.deepEqual(r2, { ok: false, error: 'nothing_to_retire: the row is already inactive' });
  const r3 = await tryFix(ports().p, { kind: 'hashtag_min_zero', channel: '@c' });
  assert.equal(r3.ok, true);
});

test('mergeToolsAllow: a list grows without repeats; a null list (no limit) is never turned into one', () => {
  assert.deepEqual(mergeToolsAllow(['web_fetch'], ['query_data', 'web_fetch']), ['web_fetch', 'query_data']);
  assert.deepEqual(mergeToolsAllow([], ['query_data']), ['query_data']);
  assert.equal(mergeToolsAllow(null, ['query_data']), null);
});

// ── A32: requiring a series' source keeps the series ─────────────────────────────────────────────────────────────

const playbook = PlaybookSchema.parse({
  platforms: [{ resource_ref: 'telegram:@c', role: 'core', formats: { text: 1 }, per_day: { min: 0, max: 3 } }],
  series: [{
    name: 'Prompt', cadence: 'daily@12:00', resource_ref: 'telegram:@c', format: 'text', brief: 'A prompt with its photo, every day.',
    source: { kind: 'library', table: 'prompts' }, source_mode: 'suggested', origin: 'agent', locked: false,
  }],
});

test('A32: the real applySeriesOp with { name, source_mode: required } changes only source_mode and locked; origin is kept', () => {
  const r = applySeriesOp(playbook, 'update', { name: 'Prompt', source_mode: 'required', source: undefined as any });
  assert.ok(!('error' in r), JSON.stringify(r));
  const before = playbook.series[0];
  const after = r.body.series[0];
  assert.deepEqual(after, { ...before, source_mode: 'required', locked: true });
  assert.equal(after.origin, 'agent', 'the series is not turned into an owner series');
  assert.deepEqual(after.source, before.source);
});

test('A32: a series_invalid refusal of the port reaches tryFix as ok: false', async () => {
  const refused = ports({
    requireSeriesSource: async () => { throw Object.assign(new Error('series_invalid'), { response: { error: 'series_invalid', details: 'the series is not valid: format unavailable' } }); },
  });
  const r = await tryFix(refused.p, { kind: 'series_source_require', channel: '@c', series: 'Prompt' });
  assert.equal(r.ok, false);
  assert.match(r.error!, /^series_invalid: /);
});
