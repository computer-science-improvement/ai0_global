/**
 * Spec 053 FR-005: the daily orchestration skips the model when there is nothing to do, gets the week's stats from code,
 * has 15 steps and no tools its prompt already answers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetworkRunner, ORCHESTRATOR_EXCLUDE } from './network-runner';
import { PlaybookSchema } from './playbook';
import { renderStatsSummary, statsSummaryOf } from './network-stats';
import type { IdeaRow } from './network.repository';
import { makeCard } from '../post/testing/fixtures';

const ORCH = 'a-orch';
const T0 = new Date('2026-10-18T08:00:00Z');

function idea(n: number, p: Partial<IdeaRow> = {}): IdeaRow {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, agentId: ORCH, title: `Ідея ${n}`, angle: null,
    sources: ['https://a.example/1'], variants: [{ resource_ref: 'telegram:@chan', format: 'text' }],
    why: 'бо так', evidence: null, origin: 'orchestrator', originRef: null, expiresAt: new Date(T0.getTime() + 86_400_000),
    status: 'accepted', revisions: 0, review: null, createdAt: T0, updatedAt: T0, ...p,
  };
}

function runner(ideas: IdeaRow[], o: { directives?: string | null } = {}) {
  const runs: any[] = [];
  const after: string[] = [];
  const orchestrator = { id: ORCH, handle: 'orch', kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@chan', status: 'active', pausedUntil: null } as any;
  const named = ['get_playbook', 'sql_readonly', 'edit_data_schema', 'search_library', 'add_idea', 'list_ideas', 'fetch_feed', 'finish_orchestration']
    .map((name) => ({ name, kind: name.startsWith('finish') ? 'terminal' : 'read' }));
  const repo: any = {
    listIdeas: async (_a: string, st: string[] | null) => ideas.filter((i) => !st || st.includes(i.status)),
    pageIdeas: async (_a: string, st: string[] | null) => { const all = ideas.filter((i) => !st || st.includes(i.status)); return { rows: all, total: all.length }; },
    recentExcerpts: async () => [],
    groupOfChannel: async () => null,
    activePlaybook: async () => ({ version: 3, body: PlaybookSchema.parse({ platforms: [{ resource_ref: 'telegram:@chan', role: 'core', formats: { text: 1 }, per_day: { min: 1, max: 3 } }] }) }),
    pendingPlaybook: async () => null,
    playbookHistory: async () => [],
    expireIdeas: async () => 0,
    releaseStalePlanned: async () => 0,
  };
  const r = new NetworkRunner({
    loop: { run: async (x: any) => { runs.push(x); return { runId: `r${runs.length}`, status: 'ok', totals: {} } as any; } },
    registry: { forRole: () => named } as any,
    runtime: { forChannel: async () => ({ agent: orchestrator, orchestrator, skills: { list: () => [], get: () => null } as any, paused: false }) } as any,
    memory: { listActive: async () => [] },
    repo,
    plans: { reservedSlots: async () => [] } as any,
    profiles: { get: async () => null } as any,
    directives: async () => o.directives ?? null,
    afterOrchestration: async () => { after.push('after'); },
    statsSummary: async (refs) => `## Статистика 7 днів\n- ${refs.join(', ')}: 5 пост.`,
    env: () => undefined,
    notify: async () => {},
    now: () => T0,
  });
  return { r, runs, after };
}

test('a full pool, no directives, nothing to revise: no model call, the upkeep still runs', async () => {
  const full = runner(Array.from({ length: 6 }, (_, k) => idea(k + 1)));
  assert.equal(await full.r.runOrchestrator(makeCard({ channelKey: '@chan' })), null);
  assert.equal(full.runs.filter((x) => x.role === 'orchestrator').length, 0);
  assert.deepEqual(full.after, ['after']);

  const revise = runner([...Array.from({ length: 6 }, (_, k) => idea(k + 1)), idea(7, { status: 'needs_revision' })]);
  await revise.r.runOrchestrator(makeCard({ channelKey: '@chan' }));
  assert.equal(revise.runs.filter((x) => x.role === 'orchestrator').length, 1, 'an idea to revise is work');

  const directed = runner(Array.from({ length: 6 }, (_, k) => idea(k + 1)), { directives: '- директива · task: пост про метро' });
  await directed.r.runOrchestrator(makeCard({ channelKey: '@chan' }));
  assert.equal(directed.runs.filter((x) => x.role === 'orchestrator').length, 1, 'a directive is always answered');
});

test('the run: 15 steps, the stats block in the message, no get_playbook / SQL / dataset edits', async () => {
  const w = runner([idea(1)]);
  await w.r.runOrchestrator(makeCard({ channelKey: '@chan' }));
  const run = w.runs.find((x) => x.role === 'orchestrator');
  assert.equal(run.maxSteps, 15);
  assert.match(run.user, /## Статистика 7 днів\n- telegram:@chan: 5 пост\./);
  assert.match(run.user, /Статистика 7 днів — нижче/);
  assert.doesNotMatch(run.user + run.system, /get_format_performance|fetch_api/);
  const names = run.tools.map((t: any) => t.name);
  for (const n of ORCHESTRATOR_EXCLUDE) assert.ok(!names.includes(n), n);
  assert.deepEqual(names, ['add_idea', 'list_ideas', 'fetch_feed', 'finish_orchestration']);
});

test('the stats block: per resource and the 3 best posts with the id repurpose_post takes; null without posts or on an error', async () => {
  const text = renderStatsSummary(
    [{ ref: 'telegram:@chan', posts: 12, avgViews: 840, bestFormat: 'photo' }, { ref: 'threads:1', posts: 3, avgViews: null, bestFormat: null }],
    [{ ref: 'telegram:@chan', format: 'photo', excerpt: 'Туманність Кільце\nдругий рядок', views: 2100, postRef: 'tg:77' }],
  )!;
  assert.match(text, /- telegram:@chan: 12 пост\., сер\. перегляди 840, найкращий формат photo/);
  assert.match(text, /- threads:1: 3 пост\., сер\. перегляди —$/m);
  assert.match(text, /- telegram:@chan · photo · 2100 перегл\. · «Туманність Кільце», published_post_id 77/);
  assert.equal(renderStatsSummary([], []), null);

  const sql: string[] = [];
  const pool = { query: async (q: string) => { sql.push(q); return { rows: q.includes('ROW_NUMBER') ? [{ ref: 'telegram:@chan', posts: 2, avg_views: '10', best_format: 'text' }] : [] }; } };
  assert.match((await statsSummaryOf(pool, ['telegram:@chan']))!, /2 пост\., сер\. перегляди 10, найкращий формат text/);
  assert.equal(sql.length, 2);
  assert.equal(await statsSummaryOf({ query: async () => { throw new Error('down'); } }, ['telegram:@chan']), null);
  assert.equal(await statsSummaryOf(pool, []), null);
});
