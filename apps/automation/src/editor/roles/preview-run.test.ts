/**
 * Spec 034 FR-012 (T7): the owner's dry-run Preview of a fixed planned slot. The executor runs with the real
 * publish tools, guards and critic, but nothing is published, stored on the slot, put up for approval or
 * written to the content ledger; act tools are left out; skip_slot only records its reason. Spend is
 * `editor.preview` (never shadow) and stops at the caps. Scripted fake LLMs only, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AgentLoop } from '../harness/agent-loop';
import { defineTool } from '../harness/tool';
import { ToolRegistry } from '../harness/tool-registry';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { OpenRouterClient } from '../llm/openrouter.client';
import { captureUsage } from '../../common/ai/usage/testing';
import { BudgetService } from '../harness/budget.service';
import { withLlmContext } from '../../common/ai/usage/llm-context';
import { buildRoleTools } from '../tools/role-tools';
import { buildComposeTools } from '../tools/compose-tools';
import { buildPlatformTools } from '../platform/platform-tools';
import { PlatformPostSpecSchema } from '../platform/platform-spec';
import type { PublishPlatformDeps } from '../platform/publish-platform';
import { CriticService } from '../critic/critic.service';
import { CRITIC_SCORE_KEYS, type CriticScores } from '../critic/critic';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { EditorRunnerService } from './editor-runner.service';
import { PREVIEW_FEATURE, PreviewSink } from './preview-run';

const NOW = new Date('2030-05-06T09:00:00Z');
const all = (n: number) => Object.fromEntries(CRITIC_SCORE_KEYS.map((k) => [k, n])) as CriticScores;
const critique = (verdict: 'pass' | 'revise' | 'reject', s: Partial<CriticScores> = {}, notes = 'Добре.') =>
  ({ calls: [{ name: 'submit_critique', args: { scores: { ...all(5), ...s }, verdict, notes } }], cost: 0.002 });

type Turns = ConstructorParameters<typeof FakeLlm>[0];

/** OpenRouter's wire format for one scripted turn (so the usage ledger sees real rows). */
function scriptedHttp(turns: Array<{ calls: Array<{ name: string; args: unknown }>; cost?: number }>) {
  let i = 0;
  return {
    post: async () => {
      const t = turns[i++];
      if (!t) throw new Error('script exhausted');
      return {
        data: {
          choices: [{
            message: { role: 'assistant', content: null, tool_calls: t.calls.map((c, k) => ({ id: `c${i}_${k}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 1000, completion_tokens: 100, cost: t.cost ?? 0.003 },
        },
      };
    },
  };
}

function harness(o: {
  executor?: Turns; http?: ReturnType<typeof scriptedHttp>; critic?: Turns; mode?: 'live' | 'approve' | 'shadow';
  budget?: FakeBudget | BudgetService; platform?: boolean;
}) {
  const slotStatus = 'planned';
  const slotRow = (id: string) => ({
    id, planId: 'p1', channelKey: '@chan', scheduledAt: new Date('2030-05-06T15:00:00Z'), kind: 'content', format: o.platform ? 'ig_carousel' : 'photo',
    topic: 'Туманність Кільце очима Вебба', angle: 'що видно на знімку', sourceHints: ['nasa.gov'], isExperiment: false, status: slotStatus, attempts: 0,
    runId: null, publishedPostId: null, postSpec: null, renderedPreview: null, error: null, ...(o.platform ? { resourceRef: 'instagram:ig1' } : {}),
  } as any);
  const writes: Array<[string, unknown]> = [];
  const sent: unknown[] = [];
  const notified: unknown[] = [];
  const inbox: unknown[] = [];
  const plans = {
    getSlot: async (id: string) => slotRow(id),
    updateSlot: async (id: string, p: unknown) => { writes.push([id, p]); },
    reservedSlots: async () => [], createPlan: async () => 'p', countPublishedSince: async () => 0, lastPostAt: async () => null,
    sourceAlreadyPosted: async () => false, recentTexts: async () => [],
    insertPublication: async () => { writes.push(['publication', null]); return 1; },
  };
  const publish: PublishPlatformDeps = {
    posts: {
      insert: async (p: any) => { writes.push(['platform_posts', p]); return { id: 1 } as any; },
      alreadyPosted: async () => false, countPublishedSince: async () => 0, lastPostAt: async () => null, recentCaptions: async () => [],
    },
    publisher: { publish: async (ref, r) => { sent.push([ref, r]); return { externalId: 'x', url: null, warnings: [] }; } },
    health: async () => null, now: () => NOW,
  };
  const repurpose = defineTool({
    name: 'repurpose_post', description: 'act tool', kind: 'act', roles: ['executor'], input: z.object({}).passthrough(),
    execute: async () => { writes.push(['repurpose', null]); return { ok: true }; },
  });
  const registry = new ToolRegistry([
    ...buildComposeTools(),
    ...buildRoleTools({
      pool: { query: async () => ({ rows: [] }) } as any, plans, memory: { listActive: async () => [] } as any, channels: {} as any,
      publisher: { send: async (_k, m) => { sent.push(m); return { messageIds: [1] }; } }, recordPublish: () => {},
      notifyPreview: async (k, h) => { notified.push([k, h]); }, now: () => NOW,
    }).filter((t) => t.name !== 'get_channel_memory'),
    ...buildPlatformTools({ pool: { query: async () => ({ rows: [] }) } as any, publish, plans }).filter((t) => t.name === 'publish_platform_post' || t.name === 'lint_platform_post'),
    repurpose,
  ]);
  const cap = captureUsage();
  const execLlm = o.http ? new OpenRouterClient({ apiKey: 'k', http: o.http as any, sleep: async () => {}, usage: cap.usage }) : new FakeLlm(o.executor ?? []);
  const recorder = new MemoryRecorder();
  const loop = new AgentLoop({ llm: execLlm, recorder, budget: o.budget ?? new FakeBudget(), enabled: () => true });
  const criticLlm = new FakeLlm(o.critic ?? []);
  const critic = new CriticService({
    loop: new AgentLoop({ llm: criticLlm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true }),
    env: () => undefined, now: () => NOW,
  });
  const runner = new EditorRunnerService({
    loop, registry, skills: new SkillLibrary(), plans: plans as any, memory: { listActive: async () => [] }, env: () => undefined,
    notify: async () => {}, now: () => NOW,
    critic: { service: critic, inbox: async (i) => { inbox.push(i); } },
  });
  const card = makeCard({ mode: o.mode ?? 'live', quietStartHour: 0, quietEndHour: 0 });
  return { runner, card, slot: slotRow('s1'), writes, sent, notified, inbox, cap, execLlm, criticLlm, recorder };
}

const publishCall = (spec = makeSpec()) => ({ calls: [{ name: 'publish_post', args: { spec } }], cost: 0.004 });

test('Telegram preview: the post is rendered and reviewed, nothing is stored, sent, notified or ledgered; the slot stays planned', async () => {
  const h = harness({ executor: [publishCall()], critic: [critique('pass')] });
  const p = await h.runner.runPreview(h.slot, h.card);
  assert.equal(p.status, 'ready', JSON.stringify(p));
  assert.equal(p.platform, 'telegram');
  assert.match(p.preview!, /Телескоп Вебб показав туманність Кільце/);
  assert.equal((p.spec as any).source.url, 'https://nasa.gov/ring');
  assert.equal(p.critic?.verdict, 'pass');
  assert.equal(p.runId, 'run-1');
  assert.equal(p.costUsd, 0.006, 'the executor run (0.004) + the critic pass (0.002)');
  assert.ok(p.finishedAt);
  assert.deepEqual(h.writes, [], 'no slot write, publication, platform post or repurpose');
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.notified, []);
  assert.deepEqual(h.inbox, []);
  // The executor saw the slot exactly as at slot time (topic, angle) and no act tools.
  const req = (h.execLlm as FakeLlm).requests[0];
  assert.match(String(req.messages.find((m) => m.role === 'user')!.content), /Туманність Кільце очима Вебба/);
  const names = (req.tools ?? []).map((t) => t.name);
  assert.ok(names.includes('publish_post') && names.includes('skip_slot'));
  assert.ok(!names.includes('repurpose_post'), 'act tools are left out of a dry run');
  assert.ok(!names.includes('publish_platform_post'));
  assert.equal(h.recorder.runs[0].slotId, 's1');
});

test('Telegram preview in approval mode never creates an approval card', async () => {
  const h = harness({ mode: 'approve', executor: [publishCall()], critic: [critique('pass')] });
  const p = await h.runner.runPreview(h.slot, h.card);
  assert.equal(p.status, 'ready');
  assert.deepEqual(h.writes, []);
});

test('the critic is part of a preview: revise → one rewrite; reject → "rejected" with the reason, never written to the slot or the Inbox', async () => {
  const rev = harness({
    executor: [publishCall(), publishCall(makeSpec({ body: [{ type: 'lead', text: 'Друга версія: Вебб показав туманність Кільце' }, { type: 'p', text: 'Оболонки газу зоря скинула тисячі років тому.' }] }))],
    critic: [critique('revise', { ai_likeness: 3 }, 'Прибери штамп.'), critique('pass')],
  });
  const p = await rev.runner.runPreview(rev.slot, rev.card);
  assert.equal(p.status, 'ready');
  assert.match(p.preview!, /Друга версія/);
  assert.equal(p.critic?.pass, 2);
  assert.equal(p.critic?.history?.[0].notes, 'Прибери штамп.');
  assert.equal(p.costUsd, 0.012, 'two executor turns + two critic passes');
  assert.deepEqual(rev.writes, []);

  const rej = harness({ executor: [publishCall()], critic: [critique('reject', { sense: 1 }, 'Не про туманність.')] });
  const r = await rej.runner.runPreview(rej.slot, rej.card);
  assert.equal(r.status, 'rejected');
  assert.match(r.reason!, /^critic_rejected: reject \(sense 1\): Не про туманність/);
  assert.equal(r.critic?.verdict, 'reject');
  assert.equal(r.preview, null);
  assert.deepEqual(rej.writes, []);
  assert.deepEqual(rej.inbox, []);
});

test('a critic that does not answer: the preview fails with the reason; no Inbox item, nothing on the slot', async () => {
  const h = harness({ executor: [publishCall()], critic: [new Error('down'), new Error('down')] });
  const p = await h.runner.runPreview(h.slot, h.card);
  assert.equal(p.status, 'failed');
  assert.match(p.reason!, /^critic_failed:/);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.inbox, []);
});

test('skip_slot in a preview records the reason; the slot is not skipped', async () => {
  const h = harness({ executor: [{ calls: [{ name: 'skip_slot', args: { reason: 'Немає перевіреного джерела про туманність' } }] }] });
  const p = await h.runner.runPreview(h.slot, h.card);
  assert.equal(p.status, 'skipped');
  assert.equal(p.reason, 'skipped by agent: Немає перевіреного джерела про туманність');
  assert.deepEqual(h.writes, []);
});

test('platform preview: every check and the critic, then stop — no platform_posts row, no API call, no slot write', async () => {
  const spec = PlatformPostSpecSchema.parse({
    format: 'ig_carousel', title: 'Пʼять фактів про Марс', caption: 'Марс — червона планета, доба там триває 24 год 37 хв.', hashtags: ['космос', 'марс'],
    slides: [{ title: 'Марс', text: 'Доба на Марсі — 24 год 37 хв.' }, { title: 'Олімп', text: 'Найвища гора Сонячної системи.' }],
  });
  const h = harness({ platform: true, executor: [{ calls: [{ name: 'publish_platform_post', args: { spec } }] }], critic: [critique('pass')] });
  const p = await h.runner.runPreview(h.slot, h.card);
  assert.equal(p.status, 'ready', JSON.stringify(p));
  assert.equal(p.platform, 'instagram');
  assert.match(p.preview!, /Марс — червона планета/);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.sent, []);
});

test('spend: the preview run is an `editor.preview` ledger row (not shadow), attributed to the slot resource', async () => {
  const h = harness({ http: scriptedHttp([{ calls: [{ name: 'publish_post', args: { spec: makeSpec() } }], cost: 0.005 }]), critic: [critique('pass')] });
  const p = await h.runner.runPreview(h.slot, h.card);
  assert.equal(p.status, 'ready', JSON.stringify(p));
  const rows = await h.cap.rows();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].feature, rows[0].role, rows[0].resource_ref, rows[0].shadow, rows[0].cost_usd], [PREVIEW_FEATURE, 'executor', 'telegram:@chan', false, 0.005]);
});

test('caps: an exhausted channel / agent budget or a blocking cap on the feature stops the preview before anything is written', async () => {
  const chan = harness({ budget: new FakeBudget([{ ok: false, scope: 'channel', spentUsd: 1, limitUsd: 1 }]), executor: [] });
  const a = await chan.runner.runPreview(chan.slot, chan.card);
  assert.equal(a.status, 'failed');
  assert.match(a.reason!, /^budget_exceeded: channel budget/);
  assert.equal((chan.execLlm as FakeLlm).requests.length, 0, 'no LLM call');

  // A blocking llm_budgets cap on the preview's own feature (spec 029): the gate sees `editor.preview`.
  const seen: string[] = [];
  const caps = {
    resourceCap: async () => null, thresholds: async () => false,
    checkFeature: async (feature: string) => {
      seen.push(feature);
      return feature === PREVIEW_FEATURE ? { ok: false, scope: 'feature', key: PREVIEW_FEATURE, spentUsd: 2, capUsd: 2 } : { ok: true };
    },
  };
  const gate = new BudgetService({ query: async () => ({ rows: [{ global_usd: 0, channel_usd: 0, agent_usd: 0, day: '2030-05-06' }] }) } as any,
    { globalDailyUsd: 100, channelDailyUsd: 100 }, () => {}, caps as any);
  const blocked = harness({ budget: gate, executor: [publishCall()] });
  const b = await blocked.runner.runPreview(blocked.slot, blocked.card);
  assert.equal(b.status, 'failed');
  assert.match(b.reason!, /^budget_exceeded: feature budget \(editor\.preview\): \$2\.0000 >= \$2/);
  assert.deepEqual(seen, [PREVIEW_FEATURE]);
  assert.equal((blocked.execLlm as FakeLlm).requests.length, 0);
  // The same gate lets an ordinary executor run through (the cap is on the preview feature only).
  assert.deepEqual(await withLlmContext({ feature: 'editor.executor' }, () => gate.check('@chan', null, null)), { ok: true });
  assert.deepEqual(blocked.writes, []);
});

test('no preview of a live or derived slot, and none while the agent is paused — no run', async () => {
  const h = harness({ executor: [] });
  const live = await h.runner.runPreview({ ...h.slot, topicMode: 'live', liveSpec: { sources: ['feed1'], brief: 'новини', max_age_hours: 6, origin: 'planner' } }, h.card);
  assert.deepEqual([live.status, live.reason], ['failed', 'preview_unavailable: a live slot picks its item at slot time']);
  const dup = await h.runner.runPreview({ ...h.slot, treatment: 'duplicate' }, h.card);
  assert.match(dup.reason!, /^preview_unavailable: a duplicate is written from its source/);
  assert.equal(h.recorder.runs.length, 0);
});

test('PreviewSink.outcome: a run without a post or a skip is "failed" with the run status', () => {
  const s = new PreviewSink();
  const o = s.outcome({ platform: 'telegram', runId: 'r', runCostUsd: 0.001, runError: 'max_steps: no terminal tool', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString() });
  assert.deepEqual([o.status, o.reason, o.costUsd], ['failed', 'max_steps: no terminal tool', 0.001]);
});
