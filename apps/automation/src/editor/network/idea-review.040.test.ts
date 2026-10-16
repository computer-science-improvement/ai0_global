/** Spec 040 FR-004: the idea pool is paged and compact, the reviewer gets its batch, adding ideas has limits. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNetworkTools, MAX_IDEAS_PER_RUN, MAX_NEW_IDEAS, REVIEW_SUMMARY_MAX } from './network-tools';
import { ideaReviewerUserPrompt } from './network-prompts';
import type { IdeaRow } from './network.repository';
import type { ToolContext } from '../harness/tool';
import { toToolContent } from '../harness/truncate';

const ORCH = 'a-orch';
const T0 = new Date('2026-10-16T08:00:00Z');

function idea(n: number, p: Partial<IdeaRow> = {}): IdeaRow {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, agentId: ORCH, title: `Ідея номер ${n}: ${'довга назва '.repeat(15)}`,
    angle: 'кут '.repeat(80), sources: [`https://www.example.com/a/${n}`, 'https://b.example.org/x'],
    variants: [{ resource_ref: 'telegram:@chan', format: 'text' }, { resource_ref: 'threads:1', format: 'text' }],
    why: 'бо дані показують інтерес '.repeat(10), evidence: null, origin: 'orchestrator', originRef: null,
    expiresAt: new Date(T0.getTime() + 86_400_000), status: 'new', revisions: 0, review: { comment: 'x'.repeat(500) },
    createdAt: new Date(T0.getTime() + n * 60_000), updatedAt: T0, ...p,
  };
}

function world(ideas: IdeaRow[]) {
  const added: unknown[] = [];
  const repo: any = {
    idea: async (id: string) => ideas.find((i) => i.id === id) ?? null,
    listIdeas: async (_a: string, st: string[] | null, limit: number) => ideas.filter((i) => !st || st.includes(i.status)).slice(0, limit),
    pageIdeas: async (_a: string, st: string[] | null, o: { limit: number; offset: number; oldestFirst?: boolean }) => {
      const all = ideas.filter((i) => !st || st.includes(i.status))
        .sort((a, b) => (o.oldestFirst ? 1 : -1) * (a.createdAt.getTime() - b.createdAt.getTime()));
      return { rows: all.slice(o.offset, o.offset + o.limit), total: all.length };
    },
    countIdeas: async (_a: string, st: string[] | null) => ideas.filter((i) => !st || st.includes(i.status)).length,
    recentExcerpts: async () => [],
    addIdea: async (x: any) => { added.push(x); const row = idea(1000 + added.length, { title: x.title, angle: x.angle }); ideas.push(row); return row; },
    updateIdea: async (id: string, p: any) => { const i = ideas.find((x) => x.id === id)!; Object.assign(i, p.status ? { status: p.status } : {}); return i; },
    rejectionCount: async () => 0,
  };
  const tools = new Map(buildNetworkTools({ repo, plans: {} as any, memory: { add: async () => 1 }, inbox: { post: async () => {} } as any, now: () => T0 }).map((t) => [t.name, t]));
  const net = {
    orchestrator: { id: ORCH, handle: 'orch' }, anchorKey: '@chan', groupId: 'g', groupName: 'net', mode: 'independent', playbook: null, playbookVersion: null,
    telegramFormats: ['text', 'photo'],
    resources: [{ ref: 'telegram:@chan', platform: 'telegram' }, { ref: 'threads:1', platform: 'threads' }],
  };
  const ctx = (): ToolContext => ({ runId: 'r', role: 'orchestrator', channelKey: '@chan', slotId: null, extras: { network: net, agent: { id: 'a-rev' } } });
  const call = (name: string, args: unknown, c: ToolContext) => tools.get(name)!.execute(tools.get(name)!.input.parse(args), c) as Promise<any>;
  return { call, ctx, ideas, added };
}

test('list_ideas: compact pages with total and next_offset; a page stays far below the tool-output cut', async () => {
  const w = world(Array.from({ length: 60 }, (_, k) => idea(k + 1)));
  const c = w.ctx();
  const p1 = await w.call('list_ideas', { status: ['new'], limit: 50, oldest_first: true }, c);
  assert.equal(p1.total, 60);
  assert.equal(p1.ideas.length, 50);
  assert.equal(p1.next_offset, 50);
  assert.equal(p1.ideas[0].id, idea(1).id, 'oldest first');
  assert.deepEqual(Object.keys(p1.ideas[0]).sort(), ['created_at', 'id', 'resources', 'source_host', 'status', 'title']);
  assert.ok(p1.ideas[0].title.length <= 120);
  assert.equal(p1.ideas[0].source_host, 'example.com');
  assert.deepEqual(p1.ideas[0].resources, ['telegram:@chan/text', 'threads:1/text']);
  assert.ok(!toToolContent(p1).includes('truncated'), 'not cut');
  assert.ok(toToolContent(p1).length < 16_384);
  const p2 = await w.call('list_ideas', { status: ['new'], limit: 50, offset: 50, oldest_first: true }, c);
  assert.equal(p2.ideas.length, 10);
  assert.equal(p2.next_offset, undefined);
  // Full ideas by id; another network's idea is not shown.
  w.ideas.push(idea(999, { agentId: 'other' }));
  const full = await w.call('list_ideas', { ids: [idea(3).id, idea(999).id] }, c);
  assert.equal(full.ideas.length, 1);
  assert.equal(full.ideas[0].why, idea(3).why);
  assert.deepEqual(full.not_found, [idea(999).id]);
});

test('the reviewer prompt carries the oldest new ideas, one line each, and how to get the rest', () => {
  const batch = [idea(1), idea(2, { revisions: 1, origin: 'owner', sources: [] })];
  const p = ideaReviewerUserPrompt({ fresh: 40, batch, pendingPlaybook: false });
  assert.match(p, /На рецензії 40 нових ідей\. Ось 2 найстаріших/);
  assert.match(p, new RegExp(`- ${idea(1).id} · «Ідея номер 1`));
  assert.match(p, /джерела: https:\/\/www\.example\.com\/a\/1 https:\/\/b\.example\.org\/x/);
  assert.match(p, /джерела: немає · варіанти: telegram:@chan\/text, threads:1\/text · походження: owner, уже доопрацьована/);
  assert.match(p, /Решта \(38\) — list_ideas\(status=\[new\], oldest_first=true, offset=2\)/);
  assert.equal(ideaReviewerUserPrompt({ fresh: 0, pendingPlaybook: true }).split('\n')[0], 'Нових ідей немає.');
});

test('finish_idea_review: refused with nothing_reviewed while ideas wait; a long summary is cut, not rejected', async () => {
  const w = world([idea(1), idea(2)]);
  const c = w.ctx();
  const r0 = await w.call('finish_idea_review', { summary: 'Все переглянуто.' }, c);
  assert.equal(r0.error, 'nothing_reviewed');
  assert.match(r0.details, /^2 нових ідей чекають/);
  const scores = { fit: 4, novelty: 4, verifiability: 4, platform_fit: 4, risk: 5 };
  assert.equal((await w.call('review_idea', { id: idea(1).id, verdict: 'accept', scores, comment: 'Добре.' }, c)).ok, true);
  const r1 = await w.call('finish_idea_review', { summary: 'Прийнято: '.repeat(600) }, c);
  assert.equal(r1.ok, true);
  assert.equal(r1.summary.length, REVIEW_SUMMARY_MAX);
  assert.equal(r1.truncated, true);
  // Nothing waiting (only a playbook to review): finishing without reviews is fine.
  const empty = world([]);
  assert.equal((await empty.call('finish_idea_review', { summary: 'Плейбук переглянуто.' }, empty.ctx())).ok, true);
});

test('add_idea: a duplicate names the idea already in the pool; per-run and backlog limits', async () => {
  const base = { angle: 'Новий кут', sources: ['https://src.example/1'], variants: [{ resource_ref: 'telegram:@chan', format: 'text' }], why: 'Бо аудиторії це цікаво.' };
  const w = world([idea(1, { title: 'Як працює квантовий компʼютер', angle: 'Простими словами' })]);
  const dup = await w.call('add_idea', { ...base, title: 'Як працює квантовий компʼютер', angle: 'Простими словами' }, w.ctx());
  assert.equal(dup.error, 'duplicate_idea');
  assert.deepEqual(dup.existing, { id: idea(1).id, title: 'Як працює квантовий компʼютер', status: 'new' });
  assert.match(dup.details, /не подавай її знову/);

  const bad = await w.call('add_idea', { ...base, title: 'Інша тема зовсім', variants: [{ resource_ref: 'telegram:@nope', format: 'text' }] }, w.ctx());
  assert.match(bad.details[0], /не ресурс мережі \(є: telegram:@chan, threads:1\)/);

  const many = world([]);
  const c = many.ctx();
  const topics = ['Вулкани Ісландії вибухають', 'Бджоли рахують до чотирьох', 'Квантові комп’ютери ламають шифри', 'Океанські течії змінюють клімат',
    'Мозок восьминога розподілений', 'Шахові дебюти Каспарова', 'Пекарня з закваскою вдома', 'Велосипедні маршрути Карпатами',
    'Стародавній Рим і бетон', 'Монети Візантії на аукціонах', 'Гриби будують мережі в лісі', 'Сонячні бурі вимикають супутники', 'Джаз Нового Орлеана'];
  const res: any[] = [];
  for (const t of topics) res.push(await many.call('add_idea', { ...base, title: t, angle: undefined }, c));
  assert.equal(res.filter((r) => r.ok).length, MAX_IDEAS_PER_RUN);
  assert.equal(res.at(-1).error, 'run_quota');

  const full = world(Array.from({ length: MAX_NEW_IDEAS }, (_, k) => idea(k + 1, { title: `Тема ${k}` })));
  const pf = await full.call('add_idea', { ...base, title: 'Зовсім нова тема про океан' }, full.ctx());
  assert.equal(pf.error, 'pool_full');
  assert.match(pf.details, /^30 ідей чекають рецензії/);
});
