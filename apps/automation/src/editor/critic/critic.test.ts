/**
 * Spec 034 T2 (FR-004): the pre-publish critic — thresholds, the critic run, the gate inside publish_post /
 * publish_platform_post (live, shadow, approval), the revise → one rewrite flow, the fail-safe, the cost
 * attribution, the approval card payload and the chat draft verdict. Scripted fake LLMs only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AgentLoop } from '../harness/agent-loop';
import { defineTool } from '../harness/tool';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { OpenRouterClient } from '../llm/openrouter.client';
import { resolveModel } from '../llm/model-registry';
import { captureUsage } from '../../common/ai/usage/testing';
import { buildRoleTools } from '../tools/role-tools';
import { buildPlatformTools } from '../platform/platform-tools';
import { PlatformPostSpecSchema } from '../platform/platform-spec';
import type { PublishPlatformDeps } from '../platform/publish-platform';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { lintPost } from '../post/lint-post';
import { ApprovalsService } from '../approval/approvals.service';
import { AutonomyService } from '../approval/autonomy';
import { EditorRunnerService } from '../roles/editor-runner.service';
import { SkillLibrary } from '../skills/skill-library';
import { DraftsService } from '../chat/drafts.service';
import { ModelsService } from '../models/models.service';
import {
  CRITIC_SCORE_KEYS, decideVerdict, heldByCritic, slopCodes, type CriticScores, type StoredCritic,
} from './critic';
import { CRITIC_ATTEMPTS, CriticService, criticSystemPrompt, criticUserPrompt, type CriticRequest } from './critic.service';
import { CriticGate, CRITIC_REVISE_GRANT_STEPS } from './critic-gate';

const NOW = new Date('2026-10-07T09:00:00Z');
const all = (n: number): CriticScores => Object.fromEntries(CRITIC_SCORE_KEYS.map((k) => [k, n])) as CriticScores;
const scores = (o: Partial<CriticScores> = {}): CriticScores => ({ ...all(5), ...o });

/** One scripted critic answer. */
const critique = (verdict: 'pass' | 'revise' | 'reject', s: Partial<CriticScores> = {}, notes = 'Добре.') =>
  ({ calls: [{ name: 'submit_critique', args: { scores: scores(s), verdict, notes } }] });

function criticOver(turns: ConstructorParameters<typeof FakeLlm>[0], o: { budget?: FakeBudget; timeoutMs?: number; criticModel?: string | null } = {}) {
  const llm = new FakeLlm(turns);
  const recorder = new MemoryRecorder();
  const loop = new AgentLoop({ llm, recorder, budget: o.budget ?? new FakeBudget(), enabled: () => true });
  const service = new CriticService({
    loop, env: () => undefined, defaultModel: async () => 'z-ai/glm-5.3-flash', criticModel: async () => o.criticModel ?? null,
    timeoutMs: o.timeoutMs, now: () => NOW,
  });
  return { service, llm, recorder };
}

// ── thresholds ──────────────────────────────────────────────────────────────

test('thresholds: any score ≤ 2 → reject; ≤ 3 → revise; ≥ 2 slop warnings → revise; humour/slang off → revise; the model can only be stricter', () => {
  assert.deepEqual(decideVerdict({ scores: all(5), verdict: 'pass' }), { verdict: 'pass', reason: 'scores_ok' });
  assert.equal(decideVerdict({ scores: all(4), verdict: 'pass' }).verdict, 'pass');
  for (const k of CRITIC_SCORE_KEYS) {
    assert.equal(decideVerdict({ scores: scores({ [k]: 2 }), verdict: 'pass' }).verdict, 'reject', `${k} = 2`);
    assert.equal(decideVerdict({ scores: scores({ [k]: 1 }), verdict: 'pass' }).verdict, 'reject', `${k} = 1`);
    assert.equal(decideVerdict({ scores: scores({ [k]: 3 }), verdict: 'pass' }).verdict, 'revise', `${k} = 3`);
  }
  assert.match(decideVerdict({ scores: scores({ sense: 2, voice: 1 }), verdict: 'pass' }).reason, /score_le_2: sense, voice/);
  assert.equal(decideVerdict({ scores: all(5), verdict: 'reject' }).verdict, 'reject', 'the model may reject');
  assert.equal(decideVerdict({ scores: all(5), verdict: 'revise' }).verdict, 'revise', 'the model may ask for a rewrite');
  assert.equal(decideVerdict({ scores: scores({ grounding: 2 }), verdict: 'revise' }).verdict, 'reject', 'but never be more lenient than the scores');
  assert.equal(decideVerdict({ scores: all(5), verdict: 'pass' }, ['slop_em_dash']).verdict, 'pass', 'one slop warning is not enough');
  assert.deepEqual(decideVerdict({ scores: all(5), verdict: 'pass' }, ['slop_em_dash', 'slop_exclamation']), { verdict: 'revise', reason: 'slop_warnings: 2' });
  assert.deepEqual(decideVerdict({ scores: all(5), verdict: 'pass' }, ['slop_humor_off']), { verdict: 'revise', reason: 'voice_off: slop_humor_off' });
  assert.equal(decideVerdict({ scores: all(5), verdict: 'pass' }, ['slop_slang_off']).verdict, 'revise');
  assert.deepEqual(slopCodes([{ code: 'slop_em_dash' }, { code: 'link_style' }, { code: 'slop_humor_off' }]), ['slop_em_dash', 'slop_humor_off']);
  assert.equal(heldByCritic(null), false);
  assert.equal(heldByCritic({ verdict: 'pass' }), false);
  assert.equal(heldByCritic({ verdict: 'revise' }), true);
  assert.equal(heldByCritic({ verdict: 'error' }), true);
});

test('humour on a humor:none resource: the lint marker turns a lenient critic pass into revise; a voice score ≤ 2 rejects', async () => {
  const card = makeCard({ hashtags: ['космос'] });
  const joke = makeSpec({ body: [{ type: 'lead', text: 'Вебб показав туманність Кільце' }, { type: 'p', text: 'Зоря скинула оболонки газу, ахаха, ну і жарт.' }] });
  const lint = lintPost(joke, card);
  assert.ok(slopCodes(lint.warnings).includes('slop_humor_off'), JSON.stringify(lint.warnings));
  assert.equal(decideVerdict({ scores: all(5), verdict: 'pass' }, slopCodes(lint.warnings)).verdict, 'revise');
  assert.equal(decideVerdict({ scores: scores({ voice: 2 }), verdict: 'pass' }, slopCodes(lint.warnings)).verdict, 'reject');

  const c = criticOver([critique('pass')]);
  const r = await c.service.review(req({ text: 'Зоря скинула оболонки газу, ахаха.', slopWarnings: lint.warnings.filter((w) => slopCodes([w]).length) }));
  assert.ok(r.ok);
  assert.equal(r.critic.verdict, 'revise');
  assert.equal(r.critic.model_verdict, 'pass');
  assert.match(c.llm.requests[0].messages[1].content as string, /Гумор: вимкнено/);
});

// ── the critic run ──────────────────────────────────────────────────────────

function req(o: Partial<CriticRequest> = {}): CriticRequest {
  return {
    channelKey: '@chan', slotId: 's1', mode: 'live', card: { models: {}, dailyBudgetUsd: null }, resourceRef: 'telegram:@chan', platform: 'telegram',
    format: 'photo', topic: 'Туманність Кільце', text: 'Телескоп Вебб показав туманність Кільце.', spec: makeSpec(), voice: {},
    brief: 'Канал про космос', slopWarnings: [], ...o,
  };
}

test('critic run: role checker, its own model (the owner\'s critic setting), voice-core + rubric in the prompt, one terminal tool', async () => {
  const c = criticOver([critique('pass', { ai_likeness: 4 })], { criticModel: 'anthropic/claude-sonnet-4.5' });
  const r = await c.service.review(req({
    source: { url: 'https://nasa.gov/ring', excerpt: 'NASA: Webb captured the Ring Nebula.' },
    slopWarnings: [{ code: 'slop_em_dash', message: '3 тире' }],
    profile: 'Аудиторія: школярі', playbook: 'Не більше одного питання', formatPrefs: '- довжина: коротко',
  }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.critic.verdict, 'pass');
  assert.equal(r.critic.pass, 1);
  assert.equal(r.critic.model, 'anthropic/claude-sonnet-4.5');
  assert.deepEqual(r.critic.slop_warnings, ['slop_em_dash']);
  assert.equal(c.recorder.runs[0].role, 'checker');
  assert.equal(c.recorder.runs[0].slotId, 's1');
  const sent = c.llm.requests[0];
  assert.equal(sent.model, 'anthropic/claude-sonnet-4.5');
  assert.deepEqual(sent.tools!.map((t) => t.name), ['submit_critique']);
  const [system, user] = [sent.messages[0].content as string, sent.messages[1].content as string];
  assert.match(system, /Критик перед публікацією/);
  assert.match(system, /voice-core/);
  for (const s of ['NASA: Webb captured', 'slop_em_dash', 'Аудиторія: школярі', 'Не більше одного питання', 'довжина: коротко', 'Канал про космос', 'Туманність Кільце']) {
    assert.ok(user.includes(s), `user prompt has ${s}`);
  }
  // Without the owner's setting the critic follows the normal resolution (the global default).
  const d = criticOver([critique('pass')]);
  await d.service.review(req());
  assert.equal(d.llm.requests[0].model, 'z-ai/glm-5.3-flash');
});

test('critic run: an error or a missing verdict is retried once, then reported (never a verdict)', async () => {
  const twice = criticOver([new Error('upstream 502'), new Error('upstream 502')]);
  const r = await twice.service.review(req());
  assert.equal(r.ok, false);
  assert.equal(twice.recorder.runs.length, CRITIC_ATTEMPTS);
  const once = criticOver([new Error('upstream 502'), critique('pass')]);
  const ok = await once.service.review(req());
  assert.ok(ok.ok);
  assert.equal(once.recorder.runs.length, 2);
  // A cap is not retried: the next call would be blocked too.
  const capped = criticOver([], { budget: new FakeBudget([{ ok: false, scope: 'feature', spentUsd: 1, limitUsd: 1 }]) });
  const b = await capped.service.review(req());
  assert.equal(b.ok, false);
  assert.match((b as any).error, /budget_exceeded/);
  assert.equal(capped.recorder.runs.length, 1);
  // A hung model times out (each attempt), then fails.
  const hung = new CriticService({
    loop: { run: () => new Promise(() => {}) }, env: () => undefined, timeoutMs: 20,
  });
  const t = await hung.review(req());
  assert.equal(t.ok, false);
  assert.match((t as any).error, /timed out/);
});

test('critic spend is a ledger row of its own feature (editor.checker), attributed to the slot resource', async () => {
  const cap = captureUsage();
  const http = {
    post: async () => ({
      data: {
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c0', type: 'function', function: { name: 'submit_critique', arguments: JSON.stringify({ scores: all(5), verdict: 'pass', notes: 'Добре.' }) } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 3000, completion_tokens: 200, cost: 0.012 },
      },
    }),
  };
  const loop = new AgentLoop({
    llm: new OpenRouterClient({ apiKey: 'k', http, sleep: async () => {}, usage: cap.usage }),
    recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true,
  });
  const svc = new CriticService({ loop, env: () => undefined });
  const r = await svc.review(req({ platform: 'instagram', resourceRef: 'instagram:ig1', mode: 'shadow' }));
  assert.ok(r.ok);
  assert.equal(r.critic.cost_usd, 0.012);
  const rows = await cap.rows();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].feature, rows[0].role, rows[0].resource_ref, rows[0].shadow, rows[0].cost_usd], ['editor.checker', 'checker', 'instagram:ig1', true, 0.012]);
});

// ── the gate in publish_post (Telegram) ─────────────────────────────────────

function telegramHarness(o: { mode: 'live' | 'shadow' | 'approve'; critic: ConstructorParameters<typeof FakeLlm>[0]; executor: ConstructorParameters<typeof FakeLlm>[0]; maxSteps?: number }) {
  const card = makeCard({ mode: o.mode, quietStartHour: 0, quietEndHour: 0 });
  const sent: unknown[] = [];
  const updates: any[] = [];
  const inbox: any[] = [];
  let status = 'running';
  const slot = () => ({ id: 's1', channelKey: '@chan', status, attempts: 1, scheduledAt: NOW, sourceHints: [], topic: 'Туманність', format: 'photo' } as any);
  const plans = {
    getSlot: async () => slot(),
    updateSlot: async (_id: string, p: any) => { updates.push(p); if (p.status) status = p.status; },
    createPlan: async () => 'p', reservedSlots: async () => [], countPublishedSince: async () => 0, lastPostAt: async () => null,
    sourceAlreadyPosted: async () => false, recentTexts: async () => [], insertPublication: async () => 1,
  };
  const tools = buildRoleTools({
    pool: { query: async () => ({ rows: [] }) } as any, plans, memory: {} as any, channels: {} as any,
    publisher: { send: async (_k, m) => { sent.push(m); return { messageIds: [42] }; } },
    media: { prepare: async () => ({ prepared: {}, cleanup: async () => {} }) },
    recordPublish: () => {}, now: () => NOW,
  }).filter((t) => t.name === 'publish_post' || t.name === 'skip_slot');
  const lintTool = defineTool({ name: 'lint_post', description: 'lint', kind: 'read', roles: ['executor'], input: z.object({}).passthrough(), execute: async () => ({ ok: true }) });
  const critic = criticOver(o.critic);
  const gate = new CriticGate(
    { critic: critic.service, plans, inbox: async (i) => { inbox.push(i); } },
    { slotId: 's1', channelKey: '@chan', mode: o.mode, resourceRef: 'telegram:@chan', platform: 'telegram', voice: {}, topic: 'Туманність' },
  );
  const execLlm = new FakeLlm(o.executor);
  const loop = new AgentLoop({ llm: execLlm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true });
  const run = () => loop.run({
    role: 'executor', channelKey: '@chan', slotId: 's1', model: resolveModel('executor', () => undefined), system: 's', user: 'u',
    tools: gate.wrapTools([...tools, lintTool]), maxSteps: o.maxSteps ?? 6, extras: { card, critic: gate },
  });
  return { run, sent, updates, inbox, critic, execLlm, status: () => status };
}

const publishCall = (spec = makeSpec()) => ({ calls: [{ name: 'publish_post', args: { spec } }] });

test('live: a critic reject never reaches the channel — the slot is skipped with the reason', async () => {
  const h = telegramHarness({ mode: 'live', critic: [critique('reject', { sense: 1 }, 'Текст не про туманність.')], executor: [publishCall()] });
  const res = await h.run();
  assert.equal(res.status, 'ok');
  assert.equal(h.sent.length, 0, 'the publisher fake is never called');
  assert.equal(h.status(), 'skipped');
  const last = h.updates.at(-1);
  assert.match(last.error, /^critic_rejected: reject \(sense 1\): Текст не про туманність/);
  assert.equal(last.critic.verdict, 'reject');
  assert.deepEqual((res.terminalResult as any).critic_rejected, true);
});

test('live: revise produces exactly one rewrite in the same run; the second critic pass sees the notes; one send', async () => {
  const first = makeSpec({ title: 'Перша версія' });
  const second = makeSpec({ title: 'Друга версія', body: [{ type: 'lead', text: 'Вебб показав туманність Кільце' }, { type: 'p', text: 'Оболонки газу зоря скинула тисячі років тому.' }] });
  const h = telegramHarness({
    mode: 'live',
    critic: [critique('revise', { ai_likeness: 3 }, 'Прибери «варто зазначити».'), critique('pass')],
    executor: [publishCall(first), publishCall(second)],
  });
  const res = await h.run();
  assert.equal(res.status, 'ok');
  assert.equal(res.terminalTool, 'publish_post');
  assert.equal(h.sent.length, 1, 'published once');
  assert.equal(h.critic.recorder.runs.length, 2, 'two critic passes');
  assert.equal(h.execLlm.requests.length, 2, 'exactly one rewrite turn');
  const toolMsg = h.execLlm.requests[1].messages.find((m) => m.role === 'tool') as any;
  assert.match(toolMsg.content, /critic_revise/);
  assert.match(toolMsg.content, /Прибери «варто зазначити»/);
  assert.match(h.critic.llm.requests[1].messages[1].content as string, /Це переписаний пост[\s\S]*Прибери «варто зазначити»/);
  const stored = h.updates.filter((u) => u.critic).at(-1).critic as StoredCritic;
  assert.equal(stored.verdict, 'pass');
  assert.equal(stored.pass, 2);
  assert.equal(stored.history?.[0].verdict, 'revise');
  assert.equal(h.status(), 'published');
  assert.equal((res.terminalResult as any).critic.verdict, 'pass');
});

test('live / shadow: a second revise is a reject; approval: it goes to the owner with the notes (final)', async () => {
  for (const mode of ['live', 'shadow'] as const) {
    const h = telegramHarness({ mode, critic: [critique('revise', { voice: 3 }), critique('revise', { voice: 3 }, 'Досі жарт.')], executor: [publishCall(), publishCall(makeSpec({ title: 'Друга' }))] });
    const res = await h.run();
    assert.equal(res.status, 'ok');
    assert.equal(h.sent.length, 0);
    assert.equal(h.status(), 'skipped', mode);
    assert.match(h.updates.at(-1).error, /critic_rejected: second revise/);
    assert.equal(h.critic.recorder.runs.length, 2, 'never a third pass');
  }
  const a = telegramHarness({ mode: 'approve', critic: [critique('revise', { voice: 3 }), critique('revise', { voice: 3 }, 'Досі жарт.')], executor: [publishCall(), publishCall(makeSpec({ title: 'Друга' }))] });
  const res = await a.run();
  assert.equal(res.status, 'ok');
  assert.equal(a.sent.length, 0);
  assert.equal(a.status(), 'awaiting_approval');
  const critic = a.updates.filter((u) => u.critic).at(-1).critic as StoredCritic;
  assert.deepEqual([critic.verdict, critic.final, critic.notes], ['revise', true, 'Досі жарт.']);
  assert.equal((res.terminalResult as any).critic.final, true);
});

test('a revise on the last step still ends in publish or skip (the loop grants turns), not max_steps', async () => {
  const h = telegramHarness({
    mode: 'live', maxSteps: 1,
    critic: [critique('revise', { ai_likeness: 3 }), critique('pass')],
    executor: [publishCall(), { calls: [{ name: 'lint_post', args: {} }] }, publishCall(makeSpec({ title: 'Друга' }))],
  });
  const res = await h.run();
  assert.equal(res.status, 'ok', res.error);
  assert.equal(res.terminalTool, 'publish_post');
  assert.equal(h.sent.length, 1);
  // Turn 1 offered every tool (the rewrite may lint); the granted last turn offers terminal tools only.
  assert.deepEqual(h.execLlm.requests[1].tools!.map((t) => t.name).sort(), ['lint_post', 'publish_post', 'skip_slot']);
  assert.deepEqual(h.execLlm.requests[2].tools!.map((t) => t.name).sort(), ['publish_post', 'skip_slot']);
  assert.equal(CRITIC_REVISE_GRANT_STEPS, 2);
});

test('fail-safe: the critic errors twice → the slot fails with an Inbox item, nothing is published (live and shadow)', async () => {
  for (const mode of ['live', 'shadow'] as const) {
    const h = telegramHarness({ mode, critic: [new Error('502'), new Error('502')], executor: [publishCall()] });
    const res = await h.run();
    assert.equal(res.status, 'ok');
    assert.equal(h.sent.length, 0);
    assert.equal(h.status(), 'failed');
    assert.match(h.updates.at(-1).error, /^critic_failed: /);
    assert.equal(h.updates.at(-1).critic.verdict, 'error');
    assert.equal(h.inbox.length, 1);
    assert.deepEqual([h.inbox[0].kind, h.inbox[0].severity, h.inbox[0].refId], ['critic_failed', 'action', 's1']);
    assert.equal(h.critic.recorder.runs.length, 2, 'retried once');
  }
  // A blocking cap stops the critic: the post does not publish live.
  const capped = telegramHarness({ mode: 'live', critic: [], executor: [publishCall()] });
  (capped.critic.service as any).d.loop = new AgentLoop({
    llm: new FakeLlm([]), recorder: new MemoryRecorder(), budget: new FakeBudget([{ ok: false, scope: 'feature', spentUsd: 2, limitUsd: 2 }]), enabled: () => true,
  });
  await capped.run();
  assert.equal(capped.sent.length, 0);
  assert.equal(capped.status(), 'failed');
  assert.match(capped.updates.at(-1).error, /budget_exceeded/);
  // Approval: the owner reviews anyway — the card is created with the critic error and is held from bulk approval.
  const a = telegramHarness({ mode: 'approve', critic: [new Error('502'), new Error('502')], executor: [publishCall()] });
  await a.run();
  assert.equal(a.status(), 'awaiting_approval');
  assert.equal(a.updates.filter((u) => u.critic).at(-1).critic.verdict, 'error');
  assert.equal(a.inbox.length, 0);
});

test('a later retry of the same passed post is not reviewed again', async () => {
  const h = telegramHarness({ mode: 'shadow', critic: [critique('pass')], executor: [] });
  const gate = new CriticGate({ critic: h.critic.service, plans: { updateSlot: async () => {} } }, { slotId: 's1', channelKey: '@chan', mode: 'shadow', resourceRef: 'telegram:@chan', platform: 'telegram', voice: {} });
  const post = { text: 't', spec: makeSpec(), format: 'photo', warnings: [] };
  assert.equal((await gate.check(post)).kind, 'proceed');
  assert.equal((await gate.check(post)).kind, 'proceed');
  assert.equal(h.critic.recorder.runs.length, 1);
});

test('the gate hands the critic the source the executor fetched', async () => {
  const c = criticOver([critique('pass')]);
  const gate = new CriticGate({ critic: c.service, plans: { updateSlot: async () => {} } }, { slotId: 's1', channelKey: '@chan', mode: 'live', resourceRef: 'telegram:@chan', platform: 'telegram', voice: {} });
  const fetchTool = defineTool({ name: 'web_fetch', description: 'f', kind: 'read', roles: ['executor'], input: z.object({ url: z.string() }), execute: async ({ url }) => ({ url, title: 'Ring', text: 'Webb imaged the Ring Nebula in 2023.' }) });
  const [wrapped] = gate.wrapTools([fetchTool]);
  await wrapped.execute({ url: 'https://nasa.gov/ring/' }, { runId: 'r', role: 'executor', channelKey: '@chan' });
  await gate.check({ text: 't', spec: makeSpec(), format: 'photo', warnings: [] });
  assert.match(c.llm.requests[0].messages[1].content as string, /Webb imaged the Ring Nebula in 2023/);
});

// ── the gate in publish_platform_post ───────────────────────────────────────

const pspec = (o: any = {}) => PlatformPostSpecSchema.parse({
  format: 'ig_carousel', title: 'Пʼять фактів про Марс', caption: 'Марс — червона планета.', hashtags: ['космос', 'марс'],
  slides: [{ title: 'Марс', text: 'Доба на Марсі — 24 год 37 хв.' }, { title: 'Олімп', text: 'Найвища гора Сонячної системи.' }], ...o,
});

function platformHarness(mode: 'live' | 'approve', criticTurns: ConstructorParameters<typeof FakeLlm>[0]) {
  const published: any[] = [];
  const inserted: any[] = [];
  const updates: any[] = [];
  let status = 'running';
  const publish: PublishPlatformDeps = {
    posts: {
      insert: async (p: any) => { inserted.push(p); return { id: inserted.length, ...p } as any; },
      alreadyPosted: async () => false, countPublishedSince: async () => 0, lastPostAt: async () => null, recentCaptions: async () => [],
    },
    publisher: { publish: async (ref, r) => { published.push([ref, r]); return { externalId: 'ig-1', url: 'https://ig/p/1', warnings: [] }; } },
    hostSlides: async (slides) => ({ prepared: { slideUrls: slides.map((_, i) => `https://h/${i}.png`) }, cleanup: async () => {} }),
    health: async () => null, now: () => NOW,
  };
  const plans = { getSlot: async () => ({ id: 's2', status } as any), updateSlot: async (_id: string, p: any) => { updates.push(p); if (p.status) status = p.status; } };
  const tool = buildPlatformTools({ pool: { query: async () => ({ rows: [] }) } as any, publish, plans }).find((t) => t.name === 'publish_platform_post')!;
  const critic = criticOver(criticTurns);
  const gate = new CriticGate({ critic: critic.service, plans }, { slotId: 's2', channelKey: '@chan', mode, resourceRef: 'instagram:ig1', platform: 'instagram', voice: {} });
  const ctx = { runId: 'r', role: 'executor' as const, channelKey: '@chan', slotId: 's2', extras: { platformSlot: { resourceRef: 'instagram:ig1', mode }, critic: gate } };
  return { tool, ctx, published, inserted, updates, critic, status: () => status };
}

test('platform: a reject never calls the platform API or stores a post; revise is a recoverable error; pass publishes', async () => {
  const rej = platformHarness('live', [critique('reject', { grounding: 1 }, 'Вигадана цифра.')]);
  const r: any = await rej.tool.execute({ spec: pspec() }, rej.ctx);
  assert.deepEqual([r.ok, r.skipped, r.critic_rejected], [true, true, true]);
  assert.equal(rej.published.length, 0);
  assert.equal(rej.inserted.length, 0);
  assert.equal(rej.status(), 'skipped');
  assert.match(rej.critic.llm.requests[0].messages[1].content as string, /Слайд 2: Олімп/);

  const rev = platformHarness('live', [critique('revise', { audience_asks: 3 }, 'Зайве питання.'), critique('pass')]);
  const e: any = await rev.tool.execute({ spec: pspec() }, rev.ctx);
  assert.equal(e.error, 'critic_revise');
  assert.equal(e._grantSteps, CRITIC_REVISE_GRANT_STEPS);
  assert.equal(rev.published.length, 0);
  const ok: any = await rev.tool.execute({ spec: pspec({ caption: 'Марс — червона планета, доба там триває 24 год 37 хв.' }) }, rev.ctx);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.critic.verdict, 'pass');
  assert.equal(rev.published.length, 1);
  assert.equal(rev.status(), 'published');

  const appr = platformHarness('approve', [critique('pass')]);
  const w: any = await appr.tool.execute({ spec: pspec() }, appr.ctx);
  assert.equal(w.awaiting_approval, true);
  assert.equal(appr.published.length, 0);
  assert.equal(appr.updates.find((u) => u.critic)?.critic.verdict, 'pass');
});

// ── the runner wires the gate ───────────────────────────────────────────────

test('runner: every executor run gets a critic gate (Telegram with the voice of the card); none without a critic', async () => {
  const runs: any[] = [];
  const webFetch = { name: 'web_fetch', execute: async () => ({}) };
  const mk = (critic?: any) => new EditorRunnerService({
    loop: { run: async (i: any) => { runs.push(i); return { runId: 'r', status: 'ok', terminalTool: 'publish_post', totals: { steps: 1, promptTokens: 0, completionTokens: 0, costUsd: 0 } } as any; } },
    registry: { forRole: () => [webFetch, { name: 'publish_post', execute: async () => ({}) }] as any },
    skills: new SkillLibrary(),
    plans: { reservedSlots: async () => [], getSlot: async () => ({ id: 's1', status: 'published' } as any), updateSlot: async () => {} },
    memory: { listActive: async () => [] },
    env: () => undefined, notify: async () => {}, now: () => NOW,
    ...(critic ? { critic: { service: critic } } : {}),
  });
  const slot: any = { id: 's1', channelKey: '@chan', scheduledAt: NOW, format: 'photo', topic: 'Тема', angle: 'Кут', sourceHints: [], isExperiment: false, attempts: 1 };
  await mk({ review: async () => ({ ok: false }) }).runExecutor(slot, makeCard({ mode: 'live', humor: 'light' }));
  const gate = runs[0].extras.critic as CriticGate;
  assert.ok(gate instanceof CriticGate);
  assert.deepEqual([gate.c.mode, gate.c.platform, gate.c.resourceRef, gate.c.voice.humor, gate.c.topic, gate.c.angle], ['live', 'telegram', 'telegram:@chan', 'light', 'Тема', 'Кут']);
  const tools = runs[0].tools as any[];
  assert.notEqual(tools.find((t) => t.name === 'web_fetch').execute, webFetch.execute, 'read tools are wrapped to capture sources');
  await mk().runExecutor(slot, makeCard());
  assert.equal(runs[1].extras.critic, undefined);
});

// ── the approval card, bulk approval and autonomy ───────────────────────────

const stored = (verdict: StoredCritic['verdict'], o: Partial<StoredCritic> = {}): StoredCritic => ({
  verdict, scores: verdict === 'error' ? null : all(4), notes: 'Нотатка', model_verdict: null, reason: 'x', pass: 1, slop_warnings: [], model: 'm',
  run_id: 'r', cost_usd: 0.01, at: NOW.toISOString(), ...o,
});

test('approval card payload carries the critic verdict, scores and notes; bulk / autonomy leave non-pass posts waiting', async () => {
  const item = (id: string, critic: StoredCritic | undefined) => ({
    id, planId: 'p', channelKey: '@chan', scheduledAt: new Date('2026-10-08T07:00:00Z'), kind: 'content', format: 'photo', topic: 'T', angle: null,
    sourceHints: [], isExperiment: false, status: 'awaiting_approval', attempts: 1, runId: null, publishedPostId: null, postSpec: makeSpec(),
    renderedPreview: 'x', error: null, planDate: '2026-10-08', planRationale: null, channelTitle: null, timezone: 'Europe/Kyiv', holdHours: 6,
    idea: null, updatedAt: NOW, ...(critic ? { critic } : {}),
  } as any);
  const approved: string[] = [];
  const items = [item('a', stored('pass')), item('b', stored('revise', { final: true, notes: 'Досі жарт.' })), item('c', stored('error')), item('d', undefined)];
  const svc = new ApprovalsService({ repo: { list: async () => items, waitingCount: async () => 4 } as any, card: async () => makeCard({ mode: 'approve' }), now: () => NOW });
  (svc as any).approve = async (id: string) => { approved.push(id); };
  const { items: cards } = await svc.list({});
  assert.deepEqual(cards[1].critic, items[1].critic);
  assert.equal(cards[1].critic!.notes, 'Досі жарт.');
  assert.equal(cards[3].critic, null);
  const bulk = await svc.bulk({ channel: '@chan' });
  assert.deepEqual(approved, ['a', 'd'], 'a pass and a post written before the critic');
  assert.equal(bulk.skippedWithWarnings, 2);

  const auto = new AutonomyService({
    stats: { report: async () => ({ totals: {}, byResource: [] }) } as any, card: async () => makeCard({ mode: 'approve' }),
    mode: async () => 'approve', setMode: async () => {}, waiting: async () => items, approve: async (id) => { approved.push(`auto:${id}`); },
  });
  const sw = await auto.switchMode({ channel: '@chan', mode: 'live', approve_waiting: true });
  assert.deepEqual(approved.filter((x) => x.startsWith('auto:')), ['auto:a', 'auto:d']);
  assert.equal(sw.skippedWithWarnings, 2);
  assert.equal((await auto.preview({ channel: '@chan' })).waitingWithWarnings, 2);
});

// ── chat drafts: advisory ───────────────────────────────────────────────────

test('chat draft: the critic verdict is stored on the draft card, a saved change clears it, and it never blocks the owner\'s publish', async () => {
  const drafts = new Map<string, any>();
  const sent: unknown[] = [];
  drafts.set('d1', { id: 'd1', chatId: null, channelKey: '@chan', spec: makeSpec(), preview: null, lint: null, status: 'draft', scheduledAt: null, slotId: null, publishedPostId: null, error: null, createdAt: NOW, updatedAt: NOW });
  const c = criticOver([critique('revise', { audience_asks: 3 }, 'Зайве питання.')]);
  const svc = new DraftsService({
    pool: { query: async () => ({ rows: [] }) } as any,
    repo: {
      getDraft: async (id) => drafts.get(id) ?? null,
      updateDraft: async (id, p) => { const d = { ...drafts.get(id), ...p }; drafts.set(id, d); return d; },
      insertDraft: async () => { throw new Error('no'); }, findDraftBySlot: async () => null, listDrafts: async () => [], myChannels: async () => [],
    },
    channels: { get: async () => makeCard({ mode: 'live' }), insertIfMissing: async () => {} } as any,
    plans: { reserveSlot: async () => 's', skipPlannedSlot: async () => true, updateSlot: async () => {}, sourceUsed: async () => false, insertPublication: async () => 1 } as any,
    publisher: { send: async (_k: string, m: unknown) => { sent.push(m); return { messageIds: [7] }; } } as any,
    recordPublish: () => {}, isPaused: () => false, notify: async () => {}, now: () => NOW,
    critic: c.service,
  });
  const r = await svc.review('d1');
  assert.ok('ok' in r && r.ok, JSON.stringify(r));
  assert.equal(r.critic.verdict, 'revise');
  assert.equal(drafts.get('d1').critic.notes, 'Зайве питання.');
  assert.equal(c.recorder.runs[0].role, 'checker');
  assert.equal(c.recorder.runs[0].slotId ?? null, null);
  const p = await svc.publish('d1');
  assert.ok('ok' in p && p.ok, JSON.stringify(p));
  assert.equal(sent.length, 1, 'advisory: the owner publishes regardless of the verdict');

  drafts.set('d2', { ...drafts.get('d1'), id: 'd2', status: 'draft', critic: stored('pass') });
  await svc.save({ chatId: null, channel: '@chan', spec: makeSpec({ title: 'Інший заголовок' }), draftId: 'd2' });
  assert.equal(drafts.get('d2').critic, null, 'a changed post needs a new verdict');
  const none = new DraftsService({ ...(svc as any).d, critic: undefined });
  assert.equal(((await none.review('d1')) as any).error, 'critic_unavailable');
});

// ── the Models page: the critic's own model ─────────────────────────────────

test('models: the owner picks the critic model; null makes it follow the default; env EDITOR_MODEL_CHECKER applies below it', async () => {
  let saved: string | null = null;
  const critic = { get: async () => saved, set: async (m: string | null) => { saved = m; } };
  const mk = (env: Record<string, string> = {}) => new ModelsService({
    pool: { query: async () => ({ rows: [] }) } as any, agents: { list: async () => [] },
    catalog: { list: async () => ({ models: [{ id: 'anthropic/claude-sonnet-4.5', name: 's', contextLength: 1, inPerM: 3, outPerM: 15, supportsReasoning: true }], fetchedAt: null, stale: false, source: 'openrouter' as const }) },
    defaults: { get: async () => null, set: async () => {} }, critic, env: (k) => env[k],
  });
  let o: any = await mk().overview();
  assert.deepEqual([o.criticModel.model, o.criticModel.source, o.criticModel.saved], ['z-ai/glm-5.3-flash', 'default', null]);
  o = await mk({ EDITOR_MODEL_CHECKER: 'z-ai/glm-5.3' }).overview();
  assert.deepEqual([o.criticModel.model, o.criticModel.source], ['z-ai/glm-5.3', 'env']);
  await mk().setCritic({ model: 'anthropic/claude-sonnet-4.5' });
  o = await mk({ EDITOR_MODEL_CHECKER: 'z-ai/glm-5.3' }).overview();
  assert.deepEqual([o.criticModel.model, o.criticModel.source, o.criticModel.saved], ['anthropic/claude-sonnet-4.5', 'critic', 'anthropic/claude-sonnet-4.5']);
  await assert.rejects(() => mk().setCritic({ model: 'nope/unknown' }), /unknown_model|Bad Request/);
  await mk().setCritic({ model: null });
  assert.equal(saved, null);
});

test('prompts: the critic system prompt carries its rubric and voice-core; the user prompt says when there is no source', () => {
  const s = criticSystemPrompt();
  assert.match(s, /submit_critique/);
  assert.match(s, /ai_likeness/);
  assert.match(s, /Голос: обовʼязковий мінімум/);
  const u = criticUserPrompt(req({ source: null }));
  assert.match(u, /Джерела немає/);
});
