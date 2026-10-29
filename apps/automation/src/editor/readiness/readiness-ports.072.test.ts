import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tryFix } from '../sysadmin/fix-runner';
import { closedSlotsPort, configSkipRecheck, readinessFixPorts, type ReadinessPortDeps } from './readiness-ports';

/**
 * Spec 072 T6, FR-004, A30, A32: the ports behind the readiness fixes, each over a fake of the service that owns the change. The
 * real `applySeriesOp` test of A32 lives with the fix runner (`sysadmin/fix-runner.072.test.ts`).
 */

function deps(over: Partial<ReadinessPortDeps> = {}) {
  const log = { upsert: [] as Array<[string, unknown]>, hashtag: [] as Array<[string, number]>, resumed: [] as string[], commits: [] as unknown[] };
  const d: ReadinessPortDeps = {
    agents: { getByHandle: async () => null },
    patchSkill: async () => undefined,
    retireMemory: async () => true,
    applyConflicts: async () => ({ applied: [], remaining: [] }),
    channels: {
      get: async () => ({ toolsAllow: ['fetch_feed'] }),
      setHashtagMin: async (k, m) => { log.hashtag.push([k, m]); return true; },
    },
    upsertChannel: async (k, p) => { log.upsert.push([k, p]); },
    pauses: { get: async () => ({ cause: 'no_material', resumedAt: null }), resume: async (id) => { log.resumed.push(id); } },
    schedule: {
      scopeByChannel: async () => ({ agent: { handle: 'orch' } }),
      commitSeriesChange: async (sc, op, fields) => { log.commits.push([sc, op, fields]); return { ok: true, version: 3 }; },
    },
    ...over,
  };
  return { d, ports: readinessFixPorts(d), log };
}

test('tools_allow_add merges into the card list and writes it through the card validation, once per tool', async () => {
  const { ports, log } = deps();
  const r = await tryFix(ports, { kind: 'tools_allow_add', channel: '@c', tools: ['query_data', 'fetch_feed'] });
  assert.equal(r.ok, true);
  assert.deepEqual(log.upsert, [['@c', { toolsAllow: ['fetch_feed', 'query_data'] }]]);
});

test('tools_allow_add never writes a list for a card that has none (no list = no limit)', async () => {
  const { ports, log } = deps({ channels: { get: async () => ({ toolsAllow: null }), setHashtagMin: async () => true } });
  const r = await tryFix(ports, { kind: 'tools_allow_add', channel: '@c', tools: ['query_data'] });
  assert.deepEqual(r, { ok: false, error: 'nothing_to_apply: the card has no tool list, so it already allows every tool' });
  assert.deepEqual(log.upsert, []);
});

test('tools_allow_add refuses a channel with no card, and passes on the card validation\'s refusal (an unknown tool)', async () => {
  const none = deps({ channels: { get: async () => null, setHashtagMin: async () => true } });
  assert.equal((await tryFix(none.ports, { kind: 'tools_allow_add', channel: '@c', tools: ['x'] })).error, 'channel_not_found: @c');
  const bad = deps({ upsertChannel: async () => { throw Object.assign(new Error('Bad Request'), { response: { error: 'invalid_card', unknownTools: ['x'] } }); } });
  const r = await tryFix(bad.ports, { kind: 'tools_allow_add', channel: '@c', tools: ['x'] });
  assert.equal(r.ok, false);
  assert.match(r.error!, /^invalid_card/);
});

test('hashtag_min_zero sets the minimum to 0 on the card', async () => {
  const { ports, log } = deps();
  assert.equal((await tryFix(ports, { kind: 'hashtag_min_zero', channel: '@c' })).ok, true);
  assert.deepEqual(log.hashtag, [['@c', 0]]);
});

test('series_resume resumes an open pause as the dashboard does; the owner\'s pause and a resumed one are refused', async () => {
  const ok = deps();
  assert.equal((await tryFix(ok.ports, { kind: 'series_resume', channel: '@c', pauseId: 'p1' })).ok, true);
  assert.deepEqual(ok.log.resumed, ['p1']);
  const owner = deps({ pauses: { get: async () => ({ cause: 'owner', resumedAt: null }), resume: async () => undefined } });
  assert.match((await tryFix(owner.ports, { kind: 'series_resume', channel: '@c', pauseId: 'p1' })).error!, /^owner_pause/);
  const done = deps({ pauses: { get: async () => ({ cause: 'no_material', resumedAt: new Date() }), resume: async () => undefined } });
  assert.match((await tryFix(done.ports, { kind: 'series_resume', channel: '@c', pauseId: 'p1' })).error!, /^already_resumed/);
  const gone = deps({ pauses: { get: async () => null, resume: async () => undefined } });
  assert.match((await tryFix(gone.ports, { kind: 'series_resume', channel: '@c', pauseId: 'p1' })).error!, /^pause_not_found/);
});

test('series_source_require updates the series with source_mode required in the channel\'s own schedule scope', async () => {
  const { ports, log } = deps();
  const r = await tryFix(ports, { kind: 'series_source_require', channel: '@c', series: 'Prompt' });
  assert.equal(r.ok, true);
  assert.deepEqual(log.commits, [[{ agent: { handle: 'orch' } }, 'update', { name: 'Prompt', source_mode: 'required' }]]);
});

test('series_source_require: a channel with no agent and a playbook that does not pass are refusals with their reasons (A32)', async () => {
  const noAgent = deps({ schedule: { scopeByChannel: async () => ({ error: 'no_agent', details: 'no agent runs @c' }), commitSeriesChange: async () => ({ ok: true }) } });
  assert.deepEqual(await tryFix(noAgent.ports, { kind: 'series_source_require', channel: '@c', series: 'P' }), { ok: false, error: 'no_agent: no agent runs @c' });
  const invalid = deps({ schedule: { scopeByChannel: async () => ({}), commitSeriesChange: async () => ({ error: 'series_invalid', details: ['cadence is wrong', 'the source is unknown'], status: 400 }) } });
  assert.deepEqual(await tryFix(invalid.ports, { kind: 'series_source_require', channel: '@c', series: 'P' }), { ok: false, error: 'series_invalid: cadence is wrong; the source is unknown' });
});

test('the audit\'s own fixes go through the same ports', async () => {
  const calls: string[] = [];
  const { ports } = deps({
    agents: { getByHandle: async (h) => ({ id: 'a1', handle: h } as any) },
    patchSkill: async (h, n, p) => { calls.push(`patch ${h} ${n} ${JSON.stringify(p)}`); },
    retireMemory: async (c, id) => { calls.push(`retire ${c} ${id}`); return true; },
    applyConflicts: async (_o, scope) => { calls.push(`apply ${JSON.stringify(scope)}`); return { applied: ['x'], remaining: [] }; },
  });
  await tryFix(ports, { kind: 'skill_disable', agent: 'fx', skill: 's1' });
  await tryFix(ports, { kind: 'memory_retire', channel: '@c', id: 7 });
  await tryFix(ports, { kind: 'conflicts_resolve', agent: 'fx', codes: ['a'], channel: '@c' });
  assert.deepEqual(calls, ['patch fx s1 {"enabled":false}', 'retire @c 7', 'apply {"codes":["a"],"ref":"telegram:@c"}']);
});

test('closedSlotsPort reads the closed slots of the last 24 hours of one resource in one query', async () => {
  const queries: Array<[string, unknown[]]> = [];
  const port = closedSlotsPort({ query: async (sql, params) => { queries.push([sql, params!]); return { rows: [{ status: 'skipped', error: 'x', verdict: 'reject' }, { status: 'published', error: null, verdict: null }] }; } });
  const now = new Date('2026-10-20T10:00:00.000Z');
  assert.deepEqual(await port('@c', now), [{ status: 'skipped', error: 'x', verdict: 'reject' }, { status: 'published', error: null, verdict: null }]);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0][1], ['telegram:@c', now]);
  assert.match(queries[0][0], /critic->>'verdict'/);
  assert.match(queries[0][0], /interval '24 hours'/);
});

// ── lead L1: the runner's onConfigSkip → a config_skip recheck ─────────────────────────────────────────────────────

test('L1: a config skip starts one config_skip recheck; a burst of one channel while it runs is dropped; no service is a no-op', async () => {
  const calls: Array<[string, string]> = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const svc = { recheck: async (key: string, reason: string) => { calls.push([key, reason]); await gate; return {} as any; } };
  const hook = configSkipRecheck(() => svc as any);
  hook('@Chan', 'config_tools_missing');
  hook('@chan', 'config_format_mismatch');
  hook('@other', 'config_series_gone');
  assert.deepEqual(calls, [['@Chan', 'config_skip'], ['@other', 'config_skip']], 'one per channel while it is under way');
  release();
  await new Promise((r) => setImmediate(r));
  hook('@chan', 'config_tools_missing');
  assert.deepEqual(calls.at(-1), ['@chan', 'config_skip'], 'a later skip rechecks again');
  // No readiness service in this process: nothing happens and nothing throws.
  assert.doesNotThrow(() => configSkipRecheck(() => undefined)('@chan', 'x'));
});

test('L1: a failing recheck is logged and never thrown at the runner', async () => {
  const logs: string[] = [];
  const hook = configSkipRecheck(() => ({ recheck: async () => { throw new Error('db down'); } }) as any, (m) => logs.push(m));
  assert.doesNotThrow(() => hook('@chan', 'config_tools_missing'));
  await new Promise((r) => setImmediate(r));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /config_skip recheck of @chan \(config_tools_missing\) failed: db down/);
});
