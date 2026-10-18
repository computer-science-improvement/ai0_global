/**
 * Spec 053 FR-004: the idea reviewer judges a batch in one call, gets novelty from code (no get_network_posts / SQL),
 * has 6 steps and a narrow tool set, and does not run for one or two fresh ideas.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNetworkTools } from './network-tools';
import { IDEA_REVIEW_MIN, IDEA_REVIEW_TOOLS, NetworkRunner } from './network-runner';
import { ideaNovelty, ideaReviewerUserPrompt } from './network-prompts';
import { PlaybookSchema } from './playbook';
import { recentTopicsOf } from '../story/recent-topics';
import type { IdeaRow } from './network.repository';
import type { ToolContext } from '../harness/tool';
import { makeCard } from '../post/testing/fixtures';

const ORCH = 'a-orch';
const T0 = new Date('2026-10-18T08:00:00Z');
const scores = { fit: 4, novelty: 4, verifiability: 4, platform_fit: 4, risk: 5 };

function idea(n: number, p: Partial<IdeaRow> = {}): IdeaRow {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, agentId: ORCH, title: `Ідея ${n}`, angle: null,
    sources: ['https://a.example/1'], variants: [{ resource_ref: 'telegram:@chan', format: 'text' }],
    why: 'бо так', evidence: null, origin: 'orchestrator', originRef: null, expiresAt: new Date(T0.getTime() + 86_400_000),
    status: 'new', revisions: 0, review: null, createdAt: new Date(T0.getTime() - 3600_000 + n * 60_000), updatedAt: T0, ...p,
  };
}

function repoOf(ideas: IdeaRow[], o: { pending?: boolean; recent?: string[] } = {}): any {
  return {
    idea: async (id: string) => ideas.find((i) => i.id === id) ?? null,
    pageIdeas: async (_a: string, st: string[] | null, q: { limit: number; offset: number }) => {
      const all = ideas.filter((i) => !st || st.includes(i.status)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return { rows: all.slice(q.offset, q.offset + q.limit), total: all.length };
    },
    countIdeas: async (_a: string, st: string[] | null) => ideas.filter((i) => !st || st.includes(i.status)).length,
    updateIdea: async (id: string, p: any) => { const i = ideas.find((x) => x.id === id)!; if (p.status) i.status = p.status; return i; },
    recentExcerpts: async () => o.recent ?? [],
    rejectionCount: async () => 0,
    groupOfChannel: async () => null,
    activePlaybook: async () => ({ version: 3, body: PlaybookSchema.parse({ platforms: [{ resource_ref: 'telegram:@chan', role: 'core', formats: { text: 1 }, per_day: { min: 1, max: 3 } }] }) }),
    pendingPlaybook: async () => (o.pending ? { id: 'pb' } : null),
  };
}

test('review_ideas: the whole batch in one call; per-idea results, the code still overrides a risky accept', async () => {
  const ideas = [idea(1), idea(2), idea(3)];
  const tools = new Map(buildNetworkTools({ repo: repoOf(ideas), plans: {} as any, memory: { add: async () => 1 }, inbox: { post: async () => {} } as any, now: () => T0 }).map((t) => [t.name, t]));
  const net = { orchestrator: { id: ORCH, handle: 'orch' }, anchorKey: '@chan', resources: [{ ref: 'telegram:@chan', platform: 'telegram' }] };
  const ctx: ToolContext = { runId: 'r', role: 'idea_reviewer', channelKey: '@chan', slotId: null, extras: { network: net, agent: { id: 'a-rev' } } };
  const t = tools.get('review_ideas')!;
  const out: any = await t.execute(t.input.parse({ reviews: [
    { id: ideas[0].id, verdict: 'accept', scores, comment: 'Пасує профілю.' },
    { id: ideas[1].id, verdict: 'accept', scores: { ...scores, risk: 2 }, comment: 'Медична порада.' },
    { id: '00000000-0000-4000-8000-000000000999', verdict: 'accept', scores, comment: 'Немає такої.' },
  ] }), ctx);
  assert.equal(out.reviewed, 2);
  assert.equal(out.failed, 1);
  assert.deepEqual(out.results.map((r: any) => r.status ?? r.error), ['accepted', 'rejected', 'idea_not_found']);
  assert.match(out.results[1].overridden, /reject/);
  assert.deepEqual(ideas.map((i) => i.status), ['accepted', 'rejected', 'new']);
  // finish_idea_review counts the batch as reviewed.
  const fin = tools.get('finish_idea_review')!;
  assert.equal(((await fin.execute(fin.input.parse({ summary: 'Прийнято одну, одну відхилено.' }), ctx)) as any).ok, true);
});

test('novelty: the closest post of 14 days and an evergreen topic of 30 days, by code', () => {
  const recent = ['Як працює квантовий компʼютер: пояснюємо просто\nтекст', 'Новий тариф на метро з понеділка'];
  const near = ideaNovelty({ title: 'Як працює квантовий компʼютер', angle: 'просте пояснення' }, recent, recentTopicsOf(recent));
  assert.match(near, /найближчий пост 14 днів «Як працює квантовий компʼютер: пояснюємо просто» \(схожість 0\.\d\d\)/);
  assert.match(near, /тема вже була за 30 днів/);
  assert.equal(ideaNovelty({ title: 'Футбольний трансфер тижня', angle: null }, recent, []), 'схожих постів за 14 днів немає');
  const p = ideaReviewerUserPrompt({ fresh: 1, batch: [idea(1)], pendingPlaybook: false, novelty: new Map([[idea(1).id, 'схожих постів за 14 днів немає']]) });
  assert.match(p, /новизна: схожих постів за 14 днів немає/);
  assert.match(p, /одним викликом review_ideas/);
  assert.doesNotMatch(p, /get_network_posts/);
});

function runner(ideas: IdeaRow[], o: { pending?: boolean } = {}) {
  const runs: any[] = [];
  const orchestrator = { id: ORCH, handle: 'orch', kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@chan', status: 'active', pausedUntil: null } as any;
  const named = ['review_ideas', 'review_idea', 'review_playbook', 'get_playbook', 'list_ideas', 'web_fetch', 'load_skill', 'finish_idea_review',
    'sql_readonly', 'get_network_posts', 'list_skills'].map((name) => ({ name, kind: name.startsWith('finish') ? 'terminal' : 'read' }));
  const r = new NetworkRunner({
    loop: { run: async (x: any) => { runs.push(x); return { runId: `r${runs.length}`, status: 'ok', totals: {} } as any; } },
    registry: { forRole: () => named } as any,
    runtime: { forChannel: async () => ({ agent: orchestrator, orchestrator, skills: { list: () => [], get: () => null } as any, paused: false }) } as any,
    memory: { listActive: async () => [] },
    repo: repoOf(ideas, { pending: o.pending, recent: ['Ідея 1 вже була постом'] }),
    plans: { reservedSlots: async () => [] } as any,
    profiles: { get: async () => null } as any,
    env: () => undefined,
    notify: async () => {},
    now: () => T0,
  });
  return { r, runs };
}

test('the reviewer runs for 3+ fresh ideas, a day-old one or a pending playbook — with 6 steps and its own tools', async () => {
  assert.equal(IDEA_REVIEW_MIN, 3);
  const few = runner([idea(1), idea(2)]);
  assert.equal(await few.r.runIdeaReview(makeCard({ channelKey: '@chan' })), null);
  assert.equal(few.runs.length, 0, 'two fresh ideas wait for company');

  const stale = runner([idea(1, { createdAt: new Date(T0.getTime() - 25 * 3600_000) })]);
  await stale.r.runIdeaReview(makeCard({ channelKey: '@chan' }));
  assert.equal(stale.runs.length, 1, 'a day-old idea is reviewed alone');

  const playbook = runner([], { pending: true });
  await playbook.r.runIdeaReview(makeCard({ channelKey: '@chan' }));
  assert.equal(playbook.runs.length, 1);

  const w = runner([idea(1), idea(2), idea(3)]);
  await w.r.runIdeaReview(makeCard({ channelKey: '@chan' }));
  const run = w.runs[0];
  assert.equal(run.maxSteps, 6);
  assert.deepEqual(run.tools.map((t: any) => t.name).sort(), [...IDEA_REVIEW_TOOLS].sort());
  assert.match(run.user, /новизна: найближчий пост 14 днів «Ідея 1 вже була постом»/);
});
