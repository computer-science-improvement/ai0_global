import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { withLlmContext, currentLlmContext } from './llm-context';
import { LlmUsageService, BudgetExceededError, classifyError, llmUsage, setLlmUsage } from './llm-usage.service';
import { isKnownFeature, editorFeature, strategyFeature } from './features';

const AGENT = '11111111-1111-4111-8111-111111111111';
const RUN   = '22222222-2222-4222-8222-222222222222';

/** Fake pool that decodes the multi-row INSERT back into objects. */
function fakePool(opts: { failTimes?: number } = {}) {
  const rows: Array<Record<string, any>> = [];
  let calls = 0;
  let fails = opts.failTimes ?? 0;
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls++;
      if (fails > 0) { fails--; throw new Error('db down'); }
      const cols = /AS v\(([^)]+)\)/.exec(sql)![1].split(',').map((c) => c.trim());
      for (let i = 0; i < params.length; i += cols.length) {
        rows.push(Object.fromEntries(cols.map((c, j) => [c, params[i + j]])));
      }
      return { rows: [], rowCount: params.length / cols.length };
    },
  };
  return { pool: pool as any, rows, calls: () => calls };
}

const prices = {
  estimate: async (provider: string, model: string, u: any) =>
    model === 'known' ? { costUsd: ((u.tokensIn ?? 0) + (u.tokensOut ?? 0)) / 1e6, source: 'estimate' as const } : { costUsd: null, source: 'unpriced' as const },
};

const svc = (p: ReturnType<typeof fakePool>, extra: Partial<ConstructorParameters<typeof LlmUsageService>[0]> = {}) =>
  new LlmUsageService({ pool: p.pool, prices, flushMs: 60_000, ...extra });

test('context: nesting inherits and overrides only the fields it sets', async () => {
  await withLlmContext({ feature: 'strategy.x.generate', resourceRef: 'strategy:x' }, async () => {
    assert.equal(currentLlmContext().feature, 'strategy.x.generate');
    await withLlmContext({ feature: 'review.post', resourceRef: undefined }, async () => {
      assert.deepEqual(currentLlmContext(), { feature: 'review.post', resourceRef: 'strategy:x' });
    });
    assert.equal(currentLlmContext().feature, 'strategy.x.generate', 'outer restored after the inner scope');
  });
  assert.deepEqual(currentLlmContext(), {}, 'nothing outside');
});

test('context survives await chains, timers, setImmediate and emitter callbacks', async () => {
  const seen: Array<string | undefined> = [];
  const bus = new EventEmitter();
  bus.on('job', () => seen.push(currentLlmContext().feature));
  await withLlmContext({ feature: 'dm.triage' }, async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 1));
    seen.push(currentLlmContext().feature);
    await new Promise<void>((r) => setImmediate(() => { seen.push(currentLlmContext().feature); r(); }));
    await (async () => { await null; seen.push(currentLlmContext().feature); })();
    bus.emit('job');
  });
  assert.deepEqual(seen, ['dm.triage', 'dm.triage', 'dm.triage', 'dm.triage']);
});

test('context in a BullMQ-style processor: each job opens its own scope; parallel jobs stay isolated', async () => {
  // A worker loop calls the processor outside any caller context, like a BullMQ Worker does.
  const processor = (job: { id: string }) => withLlmContext({ feature: 'tracking.roi', resourceRef: `telegram:${job.id}` }, async () => {
    await new Promise((r) => setTimeout(r, job.id === 'a' ? 5 : 1));
    return currentLlmContext().resourceRef;
  });
  const results = await new Promise<Array<string | null | undefined>>((resolve) => {
    setImmediate(async () => resolve(await Promise.all([processor({ id: 'a' }), processor({ id: 'b' })])));
  });
  assert.deepEqual(results, ['telegram:a', 'telegram:b']);
});

test('record: context attribution, explicit fields override, unattributed fallback', async () => {
  const p = fakePool();
  const s = svc(p);
  s.record({ provider: 'anthropic', model: 'known', tokensIn: 10, tokensOut: 5 });
  await withLlmContext({ feature: 'editor.executor', agentId: AGENT, runId: RUN, stepIdx: 2, resourceRef: 'telegram:@ch', shadow: true }, async () => {
    s.record({ provider: 'openrouter', model: 'known', tokensIn: 1, tokensOut: 1, costUsd: 0.5 });
    s.record({ provider: 'openrouter', model: 'known', feature: 'editor.reviewer', stepIdx: 7, costUsd: 0.1 });
  });
  await s.flush();
  assert.equal(p.rows.length, 3);
  assert.equal(p.rows[0].feature, 'unattributed');
  assert.equal(p.rows[0].cost_source, 'estimate');
  assert.equal(p.rows[0].cost_usd, 15 / 1e6);
  assert.equal(p.rows[1].feature, 'editor.executor');
  assert.equal(p.rows[1].agent_id, AGENT);
  assert.equal(p.rows[1].run_id, RUN);
  assert.equal(p.rows[1].step_idx, 2);
  assert.equal(p.rows[1].resource_ref, 'telegram:@ch');
  assert.equal(p.rows[1].shadow, true);
  assert.equal(p.rows[1].cost_source, 'provider');
  assert.equal(p.rows[2].feature, 'editor.reviewer');
  assert.equal(p.rows[2].step_idx, 7);
  assert.equal(p.rows[2].agent_id, AGENT, 'non-overridden fields still come from the context');
});

test('record: non-uuid agent / run ids are dropped instead of failing the batch', async () => {
  const p = fakePool();
  const s = svc(p);
  s.record({ provider: 'openai', model: 'known', agentId: 'a1', runId: 'r1', costUsd: 0 });
  await s.flush();
  assert.equal(p.rows[0].agent_id, null);
  assert.equal(p.rows[0].run_id, null);
});

test('batch flushes at the size limit', async () => {
  const p = fakePool();
  const s = svc(p, { batchSize: 3 });
  for (let i = 0; i < 3; i++) s.record({ provider: 'openai', model: 'known', costUsd: 0 });
  await new Promise((r) => setImmediate(r));
  await s.flush();
  assert.equal(p.calls(), 1, 'one INSERT for the full batch');
  assert.equal(p.rows.length, 3);
});

test('batch flushes on the timer', async () => {
  const p = fakePool();
  const s = svc(p, { flushMs: 5 });
  s.record({ provider: 'openai', model: 'known', costUsd: 0 });
  assert.equal(p.rows.length, 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(p.rows.length, 1);
});

test('a failed write is retried once, then dropped with a log — never thrown', async () => {
  const logs: string[] = [];
  const p1 = fakePool({ failTimes: 1 });
  const s1 = svc(p1, { log: (m) => logs.push(m) });
  s1.record({ provider: 'openai', model: 'known', costUsd: 0 });
  await s1.flush();
  assert.equal(p1.rows.length, 1, 'retry succeeded');

  const p2 = fakePool({ failTimes: 5 });
  const s2 = svc(p2, { log: (m) => logs.push(m) });
  s2.record({ provider: 'openai', model: 'known', costUsd: 0 });
  await s2.flush();
  assert.equal(p2.calls(), 2);
  assert.equal(p2.rows.length, 0);
  assert.match(logs.at(-1)!, /dropped/);
});

test('unknown model → unpriced, null cost, one alert per model per day (persisted key)', async () => {
  const p = fakePool();
  const claimed = new Set<string>();
  const alerts: string[] = [];
  const s = svc(p, {
    alertKeys: { claim: async (k) => { if (claimed.has(k)) return false; claimed.add(k); return true; } },
    notify: (t) => { alerts.push(t); },
  });
  s.record({ provider: 'anthropic', model: 'claude-x', tokensIn: 5, tokensOut: 5 });
  s.record({ provider: 'anthropic', model: 'claude-x', tokensIn: 5, tokensOut: 5 });
  await s.flush();
  // A "restart": a new service with the same persisted keys.
  const s2 = svc(p, { alertKeys: { claim: async (k) => !claimed.has(k) }, notify: (t) => { alerts.push(t); } });
  s2.record({ provider: 'anthropic', model: 'claude-x', tokensIn: 5, tokensOut: 5 });
  await s2.flush();
  assert.equal(p.rows.length, 3);
  assert.ok(p.rows.every((r) => r.cost_source === 'unpriced' && r.cost_usd === null));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /anthropic\/claude-x/);
});

test('start(): exactly one row per call — ok, error, timeout; latency and attempts recorded', async () => {
  const p = fakePool();
  const s = svc(p);
  const ok = s.start({ provider: 'openai', model: 'known' });
  ok.ok({ tokensIn: 100, tokensOut: 10, attempts: 2 });
  ok.ok({ tokensIn: 1 }); // a second close is ignored
  s.start({ provider: 'openai', model: 'known' }).fail(Object.assign(new Error('Request failed'), { response: { status: 500 } }));
  s.start({ provider: 'openai', model: 'known' }).fail(Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' }));
  s.start({ provider: 'anthropic', model: 'known' }).fail(new Error('overloaded'), { tokensIn: 50, tokensOut: 0 });
  await s.flush();
  assert.equal(p.rows.length, 4);
  const [a, b, c, d] = p.rows;
  assert.equal(a.status, 'ok');
  assert.equal(a.attempts, 2);
  assert.equal(typeof a.latency_ms, 'number');
  assert.deepEqual([b.status, b.error_code, b.cost_usd, b.tokens_in], ['error', 'http_500', 0, null]);
  assert.deepEqual([c.status, c.error_code, c.cost_usd], ['timeout', 'timeout', 0]);
  assert.equal(d.status, 'error');
  assert.equal(d.cost_source, 'estimate', 'a failed call that returned tokens is priced');
  assert.equal(d.cost_usd, 50 / 1e6);
});

test('start() snapshots the context at call start', async () => {
  const p = fakePool();
  const s = svc(p);
  const t = withLlmContext({ feature: 'routing.topic' }, () => s.start({ provider: 'agent_sdk', model: 'haiku' }));
  t.ok({ costUsd: 0.01 });
  await s.flush();
  assert.equal(p.rows[0].feature, 'routing.topic');
});

test('guard delegates to the budget with the context feature and resource', async () => {
  const seen: unknown[] = [];
  const s = svc(fakePool(), { budget: { assertWithin: async (f, prov, res) => { seen.push([f, prov, res]); if (f === 'blocked') throw new BudgetExceededError('global', 3, 3); } } });
  await withLlmContext({ feature: 'dm.triage', resourceRef: 'telegram:@x' }, () => s.guard('anthropic'));
  await assert.rejects(() => s.guard('anthropic', { feature: 'blocked' }), BudgetExceededError);
  await s.guard('openai');
  assert.deepEqual(seen, [['dm.triage', 'anthropic', 'telegram:@x'], ['blocked', 'anthropic', null], ['unattributed', 'openai', null]]);
});

test('classifyError and the no-op default recorder', async () => {
  assert.deepEqual(classifyError(new BudgetExceededError('global', 1, 1)), { status: 'error', errorCode: 'budget_exceeded' });
  assert.deepEqual(classifyError(Object.assign(new Error('x'), { status: 429 })), { status: 'error', errorCode: 'http_429' });
  assert.deepEqual(classifyError(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' })), { status: 'timeout', errorCode: 'timeout' });
  setLlmUsage(null);
  llmUsage().record({ provider: 'openai', model: 'x' });
  llmUsage().start({ provider: 'openai', model: 'x' }).ok();
  await llmUsage().guard('openai');
  await llmUsage().flush();
});

test('feature registry', () => {
  assert.ok(isKnownFeature(editorFeature('executor')));
  assert.ok(isKnownFeature(strategyFeature('ua-news-1')));
  assert.ok(isKnownFeature('dm.triage'));
  assert.ok(isKnownFeature('tool.web_search'));
  assert.ok(!isKnownFeature('editor.nobody'));
  assert.ok(!isKnownFeature('misc'));
});
