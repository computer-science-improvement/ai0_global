// Spec 073 T6 (FR-005, A1): when the planner gives up, the alert carries the validator's lines from the last refused
// submit_plan («Причини: …») — the single-channel planner here, the network planner below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorRunnerService } from './editor-runner.service';
import { NetworkRunner } from '../network/network-runner';
import { PlaybookSchema } from '../network/playbook';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard } from '../post/testing/fixtures';
import { reasonsClause } from '../schedule/planner-runs';

const NOW = new Date('2026-10-29T08:00:00Z');

function single(o: { lastToolErrors?: (runId: string, tool: string) => Promise<string[]>; terminalTool?: string; runId?: string | null } = {}) {
  const notes: string[] = [];
  const asked: Array<[string, string]> = [];
  const runner = new EditorRunnerService({
    loop: {
      run: async () => ({ runId: o.runId === undefined ? 'run-9' : o.runId, status: 'max_steps', error: 'step budget used', terminalTool: o.terminalTool, totals: { steps: 1, promptTokens: 0, completionTokens: 0, costUsd: 0 } }) as any,
    },
    registry: { forRole: () => [] },
    skills: new SkillLibrary(),
    plans: { reservedSlots: async () => [], getSlot: async () => null, updateSlot: async () => {} },
    memory: { listActive: async () => [] },
    env: () => undefined,
    notify: async (t: string) => { notes.push(t); },
    now: () => NOW,
    ...(o.lastToolErrors ? { lastToolErrors: async (runId: string, tool: string) => { asked.push([runId, tool]); return o.lastToolErrors!(runId, tool); } } : {}),
  } as any);
  return { runner, notes, asked };
}

test('reasonsClause: lines joined after «Причини:» on a new line; nothing for no lines', () => {
  assert.equal(reasonsClause(['a', 'b']), '\nПричини: a; b');
  assert.equal(reasonsClause([]), '');
});

test('the alert of a planner that did not plan names the validator lines of its last refused submit_plan', async () => {
  const s = single({ lastToolErrors: async () => ['слот 3: формат quiz недоступний на цьому ресурсі', 'серія «Вікторина» не поставлена на понеділок'] });
  await s.runner.runPlanner(makeCard({ channelKey: '@chan' }));
  assert.deepEqual(s.asked, [['run-9', 'submit_plan']]);
  assert.equal(s.notes.length, 1);
  assert.match(s.notes[0], /^🗓 Editor: планувальник @chan не склав план \(max_steps: step budget used\)\.\nПричини: слот 3: формат quiz недоступний на цьому ресурсі; серія «Вікторина» не поставлена на понеділок$/);
});

test('without the dependency, with no lines, with a failing lookup or with no run id the alert is the old one-liner', async () => {
  const base = '🗓 Editor: планувальник @chan не склав план (max_steps: step budget used).';
  for (const [name, s] of [
    ['no dep', single()],
    ['no lines', single({ lastToolErrors: async () => [] })],
    ['lookup throws', single({ lastToolErrors: async () => { throw new Error('db down'); } })],
    ['no run id', single({ lastToolErrors: async () => ['x'], runId: null })],
  ] as const) {
    await s.runner.runPlanner(makeCard({ channelKey: '@chan' }));
    assert.deepEqual(s.notes, [base], name);
  }
});

test('a planner that submitted a plan sends no alert and asks for no reasons', async () => {
  const s = single({ terminalTool: 'submit_plan', lastToolErrors: async () => ['x'] });
  await s.runner.runPlanner(makeCard({ channelKey: '@chan' }));
  assert.deepEqual([s.notes, s.asked], [[], []]);
});

// ── the network planner ──────────────────────────────────────────────────────

function network(o: { terminalTool?: string; lastToolErrors?: (runId: string, tool: string) => Promise<string[]> } = {}) {
  const notes: string[] = [];
  const asked: Array<[string, string]> = [];
  const orchestrator = { id: 'a-orch', handle: 'orch', kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@chan', status: 'active', pausedUntil: null } as any;
  const repo: any = {
    listIdeas: async () => [], pageIdeas: async () => ({ rows: [], total: 0 }), recentExcerpts: async () => [],
    groupOfChannel: async () => ({ id: 'g1', name: 'Мережа', mode: 'independent' }),
    groupResources: async () => [],
    activePlaybook: async () => ({ version: 3, body: PlaybookSchema.parse({ platforms: [{ resource_ref: 'telegram:@chan', role: 'core', formats: { text: 1 }, per_day: { min: 1, max: 3 } }] }) }),
    pendingPlaybook: async () => null, playbookHistory: async () => [], expireIdeas: async () => 0, releaseStalePlanned: async () => 0,
  };
  const r = new NetworkRunner({
    loop: { run: async () => ({ runId: 'run-net', status: 'max_steps', error: 'no plan', terminalTool: o.terminalTool, totals: {} }) as any },
    registry: { forRole: () => [] } as any,
    runtime: { forChannel: async () => ({ agent: orchestrator, orchestrator, skills: { list: () => [], get: () => null } as any, paused: false }) } as any,
    memory: { listActive: async () => [] },
    repo,
    plans: { reservedSlots: async () => [] } as any,
    profiles: { get: async () => null } as any,
    env: () => undefined,
    notify: async (t: string) => { notes.push(t); },
    now: () => NOW,
    ...(o.lastToolErrors ? { lastToolErrors: async (runId: string, tool: string) => { asked.push([runId, tool]); return o.lastToolErrors!(runId, tool); } } : {}),
  } as any);
  return { r, notes, asked };
}

test('the network planner\'s alert carries the lines of the last refused submit_network_plan', async () => {
  const n = network({ lastToolErrors: async () => ['instagram:1 слот 2: формат ig_story недоступний'] });
  const res = await n.r.runNetworkPlanner(makeCard({ channelKey: '@chan' }));
  assert.ok(res, 'the network planner ran');
  assert.deepEqual(n.asked, [['run-net', 'submit_network_plan']]);
  assert.equal(n.notes.length, 1);
  assert.match(n.notes[0], /^🗓 @orch: план мережі не складено \(max_steps: no plan\)\.\nПричини: instagram:1 слот 2: формат ig_story недоступний$/);

  const plain = network();
  await plain.r.runNetworkPlanner(makeCard({ channelKey: '@chan' }));
  assert.deepEqual(plain.notes, ['🗓 @orch: план мережі не складено (max_steps: no plan).']);

  const planned = network({ terminalTool: 'submit_network_plan', lastToolErrors: async () => ['x'] });
  await planned.r.runNetworkPlanner(makeCard({ channelKey: '@chan' }));
  assert.deepEqual([planned.notes, planned.asked], [[], []]);
});
