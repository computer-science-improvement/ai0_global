/**
 * Spec 040 T13: the five failing runs of the 10-16 export, replayed against the real loop and the real tools. The model is
 * scripted to repeat what it did then; each run must now stop early or succeed. Topics, ids and texts are synthetic.
 *
 *   8c07c1c1  orchestrator  114 steps, 72 errors: the same three duplicate ideas resubmitted ×24
 *   de987190  orchestrator   64 steps, 27 errors: add_idea with object sources and no variants ×20
 *   79124a8a  idea_reviewer  max_steps: list_ideas came back as a cut preview, the model paged the pool with SQL
 *   09e2bf82  planner        max_steps: series "" and the nil directive UUID, idea slots "without a source"
 *   65cccb1b  manager chat   "replan today": no tool for it, three file_directive refusals, $0.57
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../harness/agent-loop';
import type { EditorTool } from '../harness/tool';
import { ToolRegistry } from '../harness/tool-registry';
import { MemoryRecorder, FakeBudget } from '../harness/testing/fakes';
import { toToolContent } from '../harness/truncate';
import type { LlmClient, LlmRequest, LlmResponse } from '../llm/llm.types';
import { resolveModel } from '../llm/model-registry';
import { buildNetworkTools } from '../network/network-tools';
import type { IdeaRow } from '../network/network.repository';
import { buildRoleTools } from '../tools/role-tools';
import { buildScheduleTools, REPLAN_TODAY_KIND } from '../schedule/schedule-tools';
import { hasScheduleChangeIntent } from '../schedule/schedule-intent';
import { ScheduleService, type ScheduleScope } from '../schedule/schedule.service';
import { makeCard } from '../post/testing/fixtures';

type Call = { name: string; args: unknown };

/**
 * A model that keeps doing what it did in the export: it replays `opening` once, then cycles `loop` forever. Like a real model it
 * can only call the tools it is offered: a dropped tool's calls are left out, and a turn with nothing left calls `finish`.
 */
class StubbornLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  private turn = 0;
  constructor(private readonly s: { opening?: Call[][]; loop?: Call[][]; finish: Call | { text: string }; maxTurns?: number }) {}

  async chat(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    if (this.requests.length > (this.s.maxTurns ?? 60)) throw new Error('StubbornLlm: the run did not stop');
    const offered = new Set((req.tools ?? []).map((t) => t.name));
    const opening = this.s.opening ?? [];
    const loop = this.s.loop ?? [];
    const k = this.turn++;
    const planned = k < opening.length ? opening[k] : loop.length ? loop[(k - opening.length) % loop.length] : [];
    let calls = planned.filter((c) => offered.has(c.name));
    if (!calls.length) {
      if ('text' in this.s.finish) return reply(this.s.finish.text, []);
      calls = [this.s.finish];
    }
    return reply(null, calls.map((c, i) => ({ id: `c${k}_${i}`, name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) })));
  }
}

function reply(text: string | null, toolCalls: Array<{ id: string; name: string; arguments: string }>): LlmResponse {
  return {
    message: { role: 'assistant', content: text, ...(toolCalls.length ? { toolCalls } : {}) },
    finishReason: toolCalls.length ? 'tool_calls' : 'stop',
    usage: { promptTokens: 100, completionTokens: 10, costUsd: 0.0001 },
  };
}

async function replay(role: any, llm: StubbornLlm, tools: EditorTool[], extras: Record<string, unknown>, maxSteps?: number) {
  const recorder = new MemoryRecorder();
  const res = await new AgentLoop({ llm, recorder, budget: new FakeBudget(), enabled: () => true })
    .run({ role, channelKey: (extras.card as any)?.channelKey ?? null, model: resolveModel(role, () => undefined), system: 's', user: 'u', tools, extras, maxSteps });
  const steps = recorder.steps.filter((x) => x.type === 'tool');
  return { res, steps, run: recorder.runs[0], errors: steps.filter((x) => x.isError).map((x) => `${x.tool}:${(x.output as any).error}`) };
}

// ── the idea pool (orchestrator and reviewer runs) ───────────────────────────

const T0 = new Date('2026-10-11T15:11:00Z');
const ORCH = 'a-orch';
const NET = {
  orchestrator: { id: ORCH, handle: 'games' }, anchorKey: '@games', groupId: 'g', groupName: 'Games', mode: 'independent', playbook: null, playbookVersion: null,
  telegramFormats: ['text', 'photo'], resources: [{ ref: 'telegram:@games', platform: 'telegram' }, { ref: 'threads:1', platform: 'threads' }],
};

function ideaRow(n: number, p: Partial<IdeaRow> = {}): IdeaRow {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, agentId: ORCH, title: `Тема ${n}`, angle: null, sources: ['https://example.com/a'],
    variants: [{ resource_ref: 'telegram:@games', format: 'text' }], why: 'Бо аудиторії це цікаво.', evidence: null, origin: 'orchestrator', originRef: null,
    expiresAt: new Date(T0.getTime() + 3 * 86_400_000), status: 'new', revisions: 0, review: null, createdAt: new Date(T0.getTime() + n * 60_000), updatedAt: T0, ...p,
  };
}

function pool(ideas: IdeaRow[]) {
  const repo: any = {
    idea: async (id: string) => ideas.find((i) => i.id === id) ?? null,
    listIdeas: async (_a: string, st: string[] | null, limit: number) => ideas.filter((i) => !st || st.includes(i.status)).slice(0, limit),
    pageIdeas: async (_a: string, st: string[] | null, o: { limit: number; offset: number; oldestFirst?: boolean }) => {
      const all = ideas.filter((i) => !st || st.includes(i.status)).sort((a, b) => (o.oldestFirst ? 1 : -1) * (a.createdAt.getTime() - b.createdAt.getTime()));
      return { rows: all.slice(o.offset, o.offset + o.limit), total: all.length };
    },
    countIdeas: async (_a: string, st: string[] | null) => ideas.filter((i) => !st || st.includes(i.status)).length,
    recentExcerpts: async () => [],
    addIdea: async (x: any) => { const row = ideaRow(500 + ideas.length, { title: x.title, angle: x.angle, sources: x.sources, variants: x.variants }); ideas.push(row); return row; },
    updateIdea: async (id: string, p: any) => { const i = ideas.find((x) => x.id === id)!; if (p.status) i.status = p.status; return i; },
    rejectionCount: async () => 0,
  };
  return buildNetworkTools({ repo, plans: {} as any, memory: { add: async () => 1 }, inbox: { post: async () => {} } as any, now: () => T0 });
}
const pick = (tools: EditorTool[], ...names: string[]) => tools.filter((t) => names.includes(t.name));

const idea = (title: string, angle: string) => ({
  title, angle, sources: ['https://example.com/feed/1'], variants: [{ resource_ref: 'telegram:@games', format: 'text' }], why: 'Ця тема ще не публікувалась у каналі.',
});
const GIVEAWAYS = idea('Роздачі дня: що безкоштовно забрати зараз', 'Дві-три свіжі роздачі з посиланнями');
const DEVICES = idea('Девайс тижня: нова ігрова мишка', 'Короткий огляд характеристик і ціни');
const PROMO = idea('Промокоди та безкоштовні предмети в іграх', 'Що забрати цього тижня');

test('8c07c1c1: the duplicate-idea loop ends after three duplicates; add_idea is dropped and the run finishes', async () => {
  const ideas = [ideaRow(1, { title: PROMO.title, angle: PROMO.angle })];
  const llm = new StubbornLlm({
    opening: [[{ name: 'add_idea', args: GIVEAWAYS }], [{ name: 'add_idea', args: DEVICES }, { name: 'add_idea', args: PROMO }, { name: 'add_idea', args: GIVEAWAYS }]],
    loop: [[{ name: 'add_idea', args: DEVICES }, { name: 'add_idea', args: PROMO }, { name: 'add_idea', args: GIVEAWAYS }]],
    finish: { name: 'finish_orchestration', args: { summary: 'Пул поповнено двома ідеями.' } },
  });
  const r = await replay('orchestrator', llm, pick(pool(ideas), 'add_idea', 'finish_orchestration'), { network: NET });
  assert.equal(r.res.status, 'ok');
  assert.equal(r.res.terminalTool, 'finish_orchestration');
  assert.deepEqual(r.errors, [
    'add_idea:duplicate_idea', 'add_idea:duplicate_idea', 'add_idea:duplicate_idea',
    'add_idea:repeated_failed_call', 'add_idea:repeated_failed_call',
  ]);
  assert.equal(r.steps.length, 8, 'was 114 steps');
  assert.equal(ideas.length, 3, 'the two new ideas are in, nothing twice');
  assert.deepEqual(r.run.breaker, { repeatBlocked: 2, toolsDropped: ['add_idea'] });
  // The duplicate names the idea already in the pool, so the model has an id to use instead.
  assert.match((r.steps[2].output as any).details, /не подавай її знову, використовуй id 00000000-0000-4000-8000-000000000001/);
  assert.ok(!(llm.requests.at(-1)!.tools ?? []).some((t) => t.name === 'add_idea'), 'the dropped tool is no longer offered');
});

test('de987190: a malformed add_idea repeated twenty times is blocked after one run and dropped after three', async () => {
  const bad = { title: 'Decision-моделі: тренд тижня', angle: 'Три релізи за два дні', why: 'Помітний тренд тижня в новинах ШІ.',
    sources: [{ format: 'text', resource_ref: 'telegram:@games' }, { format: 'text', resource_ref: 'threads:1' }] };
  const llm = new StubbornLlm({
    opening: [[{ name: 'add_idea', args: JSON.stringify(bad).slice(0, 60) }]], // cut off mid-string: invalid_json
    loop: [[{ name: 'add_idea', args: bad }]],
    finish: { name: 'finish_orchestration', args: { summary: 'Ідею не додано: невірні аргументи.' } },
  });
  const r = await replay('orchestrator', llm, pick(pool([]), 'add_idea', 'finish_orchestration'), { network: NET });
  assert.equal(r.res.status, 'ok');
  assert.deepEqual(r.errors, ['add_idea:invalid_json', 'add_idea:invalid_args', 'add_idea:repeated_failed_call', 'add_idea:repeated_failed_call', 'add_idea:repeated_failed_call']);
  assert.equal(r.steps.length, 6, 'was 64 steps, 27 errors');
  assert.deepEqual((r.steps[1].output as any).details.map((d: any) => d.path), ['sources.0', 'sources.1', 'variants']);
  assert.match((r.steps[2].output as any).checklist[0], /^1\. .*sources\.0.*expected string, received object/, 'the blocked repeat carries the original problems');
  assert.deepEqual(r.run.breaker!.toolsDropped, ['add_idea']);
});

test('79124a8a: list_ideas answers 34 waiting ideas as one compact page (no cut preview), so the reviewer reviews and finishes', async () => {
  const ideas = Array.from({ length: 34 }, (_, k) => ideaRow(k + 1, { title: `Ідея ${k + 1}: ${'довга назва ідеї '.repeat(12)}`, angle: 'кут '.repeat(90), review: { comment: 'x'.repeat(400) } as any }));
  const tools = pool(ideas);
  const scores = { fit: 4, novelty: 4, verifiability: 4, platform_fit: 4, risk: 5 };
  const llm = new StubbornLlm({
    opening: [
      [{ name: 'list_ideas', args: { limit: 40, status: ['new'] } }],
      ideas.map((i) => ({ name: 'review_idea', args: { id: i.id, verdict: 'accept', scores, comment: 'Відповідає профілю.' } })),
    ],
    // What it did then: page the pool with SQL. The calls succeed, so only finishing ends the run.
    loop: [[{ name: 'finish_idea_review', args: { summary: 'Прийнято 34 ідеї.' } }]],
    finish: { name: 'finish_idea_review', args: { summary: 'Прийнято 34 ідеї.' } },
  });
  const r = await replay('idea_reviewer', llm, pick(tools, 'list_ideas', 'review_idea', 'finish_idea_review'), { network: NET, agent: { id: 'a-rev' } }, 25);
  const page = JSON.parse(toToolContent(r.steps[0].output));
  assert.equal(page.preview, undefined, 'the export got {"preview": "…"} here and fell back to SQL');
  assert.equal(page.total, 34);
  assert.deepEqual(page.ideas.map((i: any) => i.id), [...ideas].reverse().map((i) => i.id));
  assert.equal(r.res.status, 'ok');
  assert.equal(r.res.terminalTool, 'finish_idea_review');
  assert.deepEqual(r.errors, []);
  assert.equal(ideas.filter((i) => i.status === 'new').length, 0);
  assert.equal(llm.requests.length, 3, 'was 25 turns and max_steps');
});

test('09e2bf82: the planner\'s own plans now pass — "" and the nil directive are absent, idea slots take the idea\'s topic', async () => {
  const NIL = '00000000-0000-0000-0000-000000000000';
  const ids = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a3'];
  const rows = ids.map((id, k) => ({ id, title: `Прийнята ідея ${k + 1} про безпеку ШІ`, angle: 'Що змінилось і що робити', sources: [`https://example.com/news/${k}`] }));
  const created: any[] = [];
  const d: any = {
    pool: { query: async (_sql: string, p: any[]) => ({ rows: rows.filter((r) => (p?.[0] ?? []).includes(r.id)) }) },
    plans: { createPlan: async (...a: any[]) => { created.push(a); return 'plan-1'; }, reservedSlots: async () => [] },
    memory: { listActive: async () => [], add: async () => 1, retireByReviewer: async () => false },
    channels: { setFormatWeights: async () => ({}) }, publisher: { send: async () => ({ messageIds: [] }) }, recordPublish: () => {},
    now: () => new Date('2026-10-11T03:31:00Z'),
  };
  const submit = buildRoleTools(d).filter((t) => t.name === 'submit_plan');
  const slot = (time: string, id: string, directive = true) => ({ time, format: 'text', series: '', idea_id: id, ...(directive ? { directive_id: NIL } : {}), source_hints: [], is_experiment: false });
  const rationale = 'Три пости в найкращі години каналу, теми — три прийняті ідеї з пулу.';
  const llm = new StubbornLlm({
    opening: [
      [{ name: 'submit_plan', args: { slots: [slot('12:00', ids[0])], rationale } }],
      [{ name: 'submit_plan', args: { slots: [slot('12:00', ids[0], false), slot('14:00', ids[1], false), slot('19:00', ids[2], false)], rationale } }],
    ],
    loop: [[{ name: 'submit_plan', args: { slots: [slot('12:00', ids[0]), slot('14:00', ids[1]), slot('19:00', ids[2])], rationale } }]],
    finish: { text: 'stop' },
  });
  const r = await replay('planner', llm, submit, { card: makeCard({ channelKey: '@news' }) }, 10);
  assert.equal(r.res.status, 'ok');
  assert.equal(r.steps.length, 2, 'was 10 turns and max_steps');
  const first = (r.steps[0].output as any).details as string[];
  assert.equal(first.length, 1, 'only the real problem is left: one post where the card asks for 2–5');
  assert.match(first[0], /2–5, зараз 1/);
  assert.deepEqual(created[0][4].map((s: any) => [s.topic, s.ideaId]), rows.map((x) => [x.title, x.id]));
});

test('65cccb1b: "replan today in every channel" — @manager has a card per channel in chat, no directives, no refusals', async () => {
  const owner = 'Переплануй сьогоднішні пости в усіх каналах, що ще не вийшли';
  assert.equal(hasScheduleChangeIntent(owner), true);
  const agents: any[] = [
    { id: 'a-loko', handle: 'loko', kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@loko', parentId: null },
    { id: 'a-news', handle: 'nova', kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@nova', parentId: null },
    { id: 'a-ai0', handle: 'ai0', kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@ai0', parentId: null },
  ];
  const schedule = new (class extends ScheduleService {
    async scopeOf(a: any): Promise<ScheduleScope> { return { agent: a, card: makeCard({ channelKey: String(a.scopeId).replace('telegram:', '') }), net: { resources: [] } as any }; }
  })({
    pool: {} as any, rules: {} as any, network: {} as any, inbox: {} as any, card: async () => null,
    agents: { getByHandle: async (h: string) => agents.find((a) => a.handle === h) ?? null, get: async (id: string) => agents.find((a) => a.id === id) ?? null,
      findTop: async (_k: string, _s: string, ref: string) => agents.find((a) => a.scopeId === ref) ?? null } as any,
    plans: { getSlot: async () => null, reservedSlots: async () => [] } as any, now: () => new Date('2026-10-16T10:26:00Z'),
  } as any);
  const cards: any[] = [];
  const registry = new ToolRegistry(buildScheduleTools({ schedule, actions: { propose: async (a: any) => { cards.push(a); return { id: `pa${cards.length}`, ...a }; } }, now: () => new Date('2026-10-16T10:26:00Z') }));
  assert.ok(!registry.forRole('manager').some((t) => t.name === 'propose_replan_today'), 'not in the manager\'s autonomous run');
  const tools = registry.forRole('manager', null, { chat: true });
  const llm = new StubbornLlm({
    opening: [['@loko', '@nova', '@ai0'].map((channel) => ({ name: 'propose_replan_today', args: { channel } }))],
    finish: { text: 'Три картки «Replan today» — натисни Apply у тих каналах, які перепланувати.' },
  });
  const manager = { id: 'a-mgr', handle: 'manager', kind: 'manager', scope: 'system', scopeId: null, parentId: null };
  const r = await replay('manager', llm, tools, { chat: { chatId: 'c1', channelKey: null }, agentIntent: false, ownerText: owner, agent: manager });
  assert.equal(r.res.status, 'ok');
  assert.deepEqual(r.errors, [], 'was 3× file_directive needs_explicit_request');
  assert.deepEqual(cards.map((c) => [c.kind, c.payload.channel_key]), [[REPLAN_TODAY_KIND, '@loko'], [REPLAN_TODAY_KIND, '@nova'], [REPLAN_TODAY_KIND, '@ai0']]);
  assert.equal(llm.requests.length, 2, 'was 12 turns and $0.57');
});
