/**
 * Spec 046 FR-007: an orchestrator adds about a day of slots + 1 ideas, wakes only for the directives that need ideas,
 * a news resource's idea stands on two sources, and a backlog over one batch gets a second review batch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNetworkTools, ideaQuota, MAX_IDEAS_PER_RUN } from './network-tools';
import { NetworkRunner } from './network-runner';
import { PlaybookSchema } from './playbook';
import type { IdeaRow } from './network.repository';
import type { ToolContext } from '../harness/tool';
import { makeCard } from '../post/testing/fixtures';
import { ResourceProfileSchema } from '../agents/resource-profile';
import { WAKE_KINDS } from '../manager/manager-runner';

const ORCH = 'a-orch';
const T0 = new Date('2026-10-17T08:00:00Z');

function idea(n: number, p: Partial<IdeaRow> = {}): IdeaRow {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, agentId: ORCH, title: `Ідея ${n}`, angle: null,
    sources: ['https://a.example/1', 'https://b.example/2'], variants: [{ resource_ref: 'telegram:@chan', format: 'text' }],
    why: 'бо так', evidence: null, origin: 'orchestrator', originRef: null, expiresAt: new Date(T0.getTime() + 86_400_000),
    status: 'new', revisions: 0, review: null, createdAt: new Date(T0.getTime() + n * 60_000), updatedAt: T0, ...p,
  };
}

function repoOf(ideas: IdeaRow[]): any {
  return {
    idea: async (id: string) => ideas.find((i) => i.id === id) ?? null,
    listIdeas: async (_a: string, st: string[] | null, limit: number) => ideas.filter((i) => !st || st.includes(i.status)).slice(0, limit),
    pageIdeas: async (_a: string, st: string[] | null, o: { limit: number; offset: number }) => {
      const all = ideas.filter((i) => !st || st.includes(i.status)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return { rows: all.slice(o.offset, o.offset + o.limit), total: all.length };
    },
    countIdeas: async (_a: string, st: string[] | null) => ideas.filter((i) => !st || st.includes(i.status)).length,
    recentExcerpts: async () => [],
    addIdea: async (x: any) => { const row = idea(1000 + ideas.length, { title: x.title, sources: x.sources }); ideas.push(row); return row; },
    rejectionCount: async () => 0,
    groupOfChannel: async () => null,
    activePlaybook: async () => ({ version: 3, body: PlaybookSchema.parse({ platforms: [{ resource_ref: 'telegram:@chan', role: 'core', formats: { text: 1 }, per_day: { min: 1, max: 3 } }] }) }),
    pendingPlaybook: async () => null,
    playbookHistory: async () => [],
    expireIdeas: async () => 0,
    releaseStalePlanned: async () => 0,
  };
}

test('046: ideas per run are a day of slots + 1, never past the 2-day runway', () => {
  assert.equal(ideaQuota(3, 0), 4);
  assert.equal(ideaQuota(3, 4), 2);
  assert.equal(ideaQuota(3, 6), 0);
  assert.equal(ideaQuota(3, 40), 0);
  assert.equal(ideaQuota(0, 0), 2, 'a resource with no slots still gets a spare idea');
  assert.equal(ideaQuota(30, 0), MAX_IDEAS_PER_RUN);
});

function tools(ideas: IdeaRow[]) {
  const map = new Map(buildNetworkTools({ repo: repoOf(ideas), plans: {} as any, memory: { add: async () => 1 }, inbox: { post: async () => {} } as any, now: () => T0 }).map((t) => [t.name, t]));
  const net = {
    orchestrator: { id: ORCH, handle: 'orch' }, anchorKey: '@chan', groupId: null, groupName: null, mode: 'single', playbook: null, playbookVersion: null,
    telegramFormats: ['text', 'photo'], resources: [{ ref: 'telegram:@chan', platform: 'telegram' }],
  };
  const ctx = (extras: Record<string, unknown>): ToolContext => ({ runId: 'r', role: 'orchestrator', channelKey: '@chan', slotId: null, extras: { network: net, ...extras } });
  const call = (args: Record<string, unknown>, c: ToolContext) => map.get('add_idea')!.execute(map.get('add_idea')!.input.parse({
    variants: [{ resource_ref: 'telegram:@chan', format: 'text' }], why: 'Аудиторії це цікаво.', ...args,
  }), c) as Promise<any>;
  return { call, ctx };
}

test('046: add_idea keeps to the run quota the runner set', async () => {
  const w = tools([]);
  const c = w.ctx({ ideaQuota: 2 });
  const titles = ['Вулкани Ісландії прокинулись', 'Бджоли рахують до чотирьох', 'Шахові дебюти Каспарова'];
  const res: any[] = [];
  for (const title of titles) res.push(await w.call({ title, sources: ['https://a.example/x', 'https://b.example/y'] }, c));
  assert.deepEqual(res.map((r) => r.ok ?? r.error), [true, true, 'run_quota']);
  assert.match(res[2].details, /межа 2/);
  const none = await w.call({ title: 'Океанські течії і клімат', sources: ['https://a.example/x'] }, w.ctx({ ideaQuota: 0 }));
  assert.equal(none.error, 'run_quota');
  assert.match(none.details, /вистачає на 2 дні/);
});

test('046: a news resource idea needs two sources from different sites', async () => {
  const w = tools([]);
  const news = { ideaQuota: 5, newsRefs: ['telegram:@chan'] };
  const one = await w.call({ title: 'Київ відкрив новий міст', sources: ['https://news.example/a'] }, w.ctx(news));
  assert.equal(one.error, 'idea_invalid');
  assert.match(one.details[0], /новинний ресурс: потрібні щонайменше 2/);
  const sameSite = await w.call({ title: 'Київ відкрив новий міст', sources: ['https://www.news.example/a', 'https://news.example/b'] }, w.ctx(news));
  assert.equal(sameSite.error, 'idea_invalid');
  const two = await w.call({ title: 'Київ відкрив новий міст', sources: ['https://news.example/a', 'https://other.example/b'] }, w.ctx(news));
  assert.equal(two.ok, true);
  const owner = await w.call({ title: 'Власник просив про метро', sources: ['https://news.example/m'], origin: 'owner' }, w.ctx(news));
  assert.equal(owner.ok, true, 'owner and series ideas are not held to it');
  const general = await w.call({ title: 'Як працює метро', sources: ['https://news.example/x'] }, w.ctx({ ideaQuota: 5, newsRefs: [] }));
  assert.equal(general.ok, true);
});

function runner(ideas: IdeaRow[], o: { directives?: string | null; news?: boolean; review?: (n: number) => void } = {}) {
  const runs: any[] = [];
  const orchestrator = { id: ORCH, handle: 'orch', kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@chan', status: 'active', pausedUntil: null } as any;
  const r = new NetworkRunner({
    loop: { run: async (x: any) => { runs.push(x); if (x.role === 'idea_reviewer') o.review?.(runs.length); return { runId: `r${runs.length}`, status: 'ok', totals: {} } as any; } },
    registry: { forRole: () => [] },
    runtime: { forChannel: async () => ({ agent: orchestrator, orchestrator, skills: { list: () => [], get: () => null } as any, paused: false }) } as any,
    memory: { listActive: async () => [] },
    repo: repoOf(ideas),
    plans: { reservedSlots: async () => [] } as any,
    profiles: { get: async () => (o.news ? { profile: ResourceProfileSchema.parse({ topic: 'Новини Києва', audience: { who: 'кияни' }, goals: ['growth'] }) } : null) as any },
    directives: async () => o.directives ?? null,
    env: () => undefined,
    notify: async () => {},
    now: () => T0,
  });
  return { r, runs };
}

test('046: a backlog over one batch gets a second review batch, only when the first one moved it', async () => {
  const ideas = Array.from({ length: 20 }, (_, k) => idea(k + 1));
  const drain = (n: number) => () => { for (const i of ideas.filter((x) => x.status === 'new').slice(0, n)) i.status = 'accepted'; };
  const w = runner(ideas, { review: drain(15) });
  await w.r.runIdeaReview(makeCard({ channelKey: '@chan' }));
  assert.equal(w.runs.length, 2);
  assert.match(w.runs[1].user, /5/);

  const stuck = Array.from({ length: 20 }, (_, k) => idea(k + 1));
  const s = runner(stuck);
  await s.r.runIdeaReview(makeCard({ channelKey: '@chan' }));
  assert.equal(s.runs.length, 1, 'nothing reviewed → no second batch');

  const small = Array.from({ length: 10 }, (_, k) => idea(k + 1));
  const m = runner(small, { review: () => { for (const i of small) i.status = 'accepted'; } });
  await m.r.runIdeaReview(makeCard({ channelKey: '@chan' }));
  assert.equal(m.runs.length, 1);
});

test('046: a wake-up run needs its directives; the run carries the idea quota and the news resources', async () => {
  const idle = runner([]);
  assert.equal(await idle.r.runOrchestrator(makeCard({ channelKey: '@chan' }), { wake: true }), null);
  assert.equal(idle.runs.length, 0, 'no directive left to answer → no run');

  const pool = Array.from({ length: 4 }, (_, k) => idea(k + 1, { status: 'accepted' }));
  const w = runner(pool, { directives: '- директива · task: пост про метро', news: true });
  await w.r.runOrchestrator(makeCard({ channelKey: '@chan' }), { wake: true });
  const orch = w.runs.find((x) => x.role === 'orchestrator');
  assert.equal(orch.extras.ideaQuota, 2, '3 slots a day, 4 accepted → 2 more fill the 2-day runway');
  assert.deepEqual(orch.extras.newsRefs, ['telegram:@chan']);
  assert.match(orch.user, /додай до 2 ідей/);
  assert.deepEqual([...WAKE_KINDS], ['task', 'experiment', 'cross_promo']);
});
