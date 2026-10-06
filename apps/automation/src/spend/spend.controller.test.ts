/**
 * HTTP-level test of SpendController and OverviewController (spec 029 FR-011) on an
 * in-process Nest app bound to 127.0.0.1: the real TrackingAuthGuard, routing, zod
 * validation errors, the streamed CSV and the budget/price edits. No DB, no network.
 */
import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth/auth.service';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { makeAuth } from '../auth/testing/fakes';
import { OVERVIEW_AGENTS, OverviewController, SPEND_SERVICE, SpendController } from './spend.controller';
import { SpendService } from './spend.service';
import type { Agg } from './spend.repository';

const TOKEN = 'test-token';
const agg = (o: Partial<Agg>): Agg => ({
  key: '', calls: 0, errors: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0, estimatedUsd: 0, unpricedCalls: 0, shadowUsd: 0, avgLatencyMs: null, noUsageCalls: null, ...o,
});
const GROUPS = [agg({ key: 'editor.executor', calls: 3, costUsd: 0.75 }), agg({ key: 'dm.triage', calls: 2, costUsd: 0.25 })];
const budgets = new Map<number, any>([
  [1, { id: 1, scope_kind: 'global', scope_key: '', daily_usd: 3, monthly_usd: null, alert_pct: 80, enforce: true, seeded_from: 'AI_DAILY_BUDGET_USD' }],
  [2, { id: 2, scope_kind: 'provider', scope_key: 'xai', daily_usd: 1, monthly_usd: null, alert_pct: 80, enforce: true, seeded_from: null }],
]);
const invalidated = { prices: 0, budgets: 0 };
const repo: any = {
  aggregate: async (_s: string, _r: unknown, g: string | null) => (g ? GROUPS : [agg({ calls: 5, costUsd: 1 })]),
  daily: async () => [{ day: '2026-10-05', stack: 'openrouter', usd: 1 }],
  rollupByDay: async () => [],
  rawPage: async (_r: unknown, _f: unknown, after: number) => (after ? [] : [{ id: 1, at: '2026-10-06T08:00:00.000Z', provider: 'openrouter', model: 'm', kind: 'llm', feature: 'editor.executor', costUsd: 0.1, shadow: false }]),
  agentHandles: async () => new Map(),
  todaySlices: async () => [{ feature: 'x', provider: 'xai', resourceRef: null, rootAgentId: null, usd: 1.2 }],
  monthSlicesBeforeToday: async () => [],
  agentCaps: async () => [],
  listPrices: async () => [{ provider: 'openai', model: 'gpt-4o', in_per_m: 2.5, out_per_m: 10, cached_read_per_m: 1.25, cached_write_per_m: null, per_request_usd: null, effective_from: '2026-01-01', note: null, updated_at: null }],
  unpricedModels: async () => [],
  upsertPrice: async () => ({ created: true }),
  deletePrice: async () => true,
  repriceCandidates: async () => [],
  applyReprice: async () => 0,
  listBudgets: async () => [...budgets.values()],
  getBudget: async (id: number) => budgets.get(id) ?? null,
  upsertBudget: async (b: any) => ({ id: b.id ?? 3, created: b.id == null }),
  deleteBudget: async (id: number) => budgets.delete(id),
  callsBeforeLedger: async () => 42,
};
const svc = new SpendService({
  repo, prices: { price: async () => null, invalidate: () => { invalidated.prices++; } },
  budgets: { invalidate: () => { invalidated.budgets++; } }, rollup: { rollup: async () => 0 },
  now: () => new Date('2026-10-06T09:00:00Z'),
});
const overview = { load: async () => ({ agents: { total: 2, byMode: { off: 0, shadow: 1, approve: 1, live: 0 }, paused: 0 } }) };

let app: INestApplication;
let port: number;

before(async () => {
  Reflect.defineMetadata('design:paramtypes', [AuthService], TrackingAuthGuard);
  for (const m of ['summary', 'breakdown', 'prices', 'deletePrice']) Reflect.defineMetadata('design:paramtypes', [Object], SpendController.prototype, m);
  for (const m of ['putPrice', 'reprice', 'putBudget']) Reflect.defineMetadata('design:paramtypes', [Object], SpendController.prototype, m);
  Reflect.defineMetadata('design:paramtypes', [Object, Object], SpendController.prototype, 'exportCsv');
  Reflect.defineMetadata('design:paramtypes', [Number], SpendController.prototype, 'deleteBudget');
  @Module({
    controllers: [SpendController, OverviewController],
    providers: [
      { provide: ConfigService, useValue: { get: (k: string) => ({ TRACKING_TOKEN: TOKEN } as any)[k] } },
      { provide: AuthService, useValue: makeAuth({ TRACKING_TOKEN: TOKEN }).auth },
      { provide: SPEND_SERVICE, useValue: svc },
      { provide: OVERVIEW_AGENTS, useValue: overview },
    ],
  })
  class TestModule {}
  app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
  await app.listen(0, '127.0.0.1');
  port = (app.getHttpServer().address() as AddressInfo).port;
});
after(async () => { await app?.close(); });

function call(method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<{ status: number; text: string; json: any; headers: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port, method, path,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-type': 'application/json' } : {}) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json: any = null;
        try { json = JSON.parse(buf); } catch { /* csv */ }
        resolve({ status: res.statusCode ?? 0, text: buf, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('every spend endpoint requires the tracking token', async () => {
  for (const [m, p] of [
    ['GET', '/api/spend/summary'], ['GET', '/api/spend/breakdown'], ['GET', '/api/spend/export.csv'], ['GET', '/api/spend/prices'],
    ['PUT', '/api/spend/prices'], ['DELETE', '/api/spend/prices'], ['POST', '/api/spend/reprice'], ['GET', '/api/spend/budgets'],
    ['PUT', '/api/spend/budgets'], ['DELETE', '/api/spend/budgets/2'], ['GET', '/api/overview/agents'], ['GET', '/api/spend/ledger'],
  ]) {
    assert.equal((await call(m, p, undefined, null)).status, 401, `${m} ${p}`);
  }
});

test('summary, breakdown, ledger and overview answer with data', async () => {
  const s = await call('GET', '/api/spend/summary?range=30d');
  assert.equal(s.status, 200);
  assert.equal(s.json.range, '30d');
  assert.ok(s.json.periods.today && s.json.periods['7d'] && s.json.periods['30d']);
  assert.equal(s.json.blocking[0].label, 'Provider xai');
  const b = await call('GET', '/api/spend/breakdown?range=7d&groupBy=feature&feature=editor.&provider=openrouter&shadow=0');
  assert.equal(b.status, 200);
  assert.equal(b.json.source, 'rollup');
  assert.deepEqual(b.json.rows.map((r: any) => [r.key, r.pct]), [['editor.executor', 75], ['dm.triage', 25]]);
  assert.equal(b.json.chart.days.length, 7);
  assert.equal((await call('GET', '/api/spend/ledger')).json.callsBeforeLedger, 42);
  assert.equal((await call('GET', '/api/overview/agents')).json.agents.byMode.approve, 1);
});

test('validation errors are 400 with issues', async () => {
  for (const p of ['/api/spend/breakdown?groupBy=week', '/api/spend/breakdown?range=year', '/api/spend/breakdown?from=2026-01-01',
    '/api/spend/breakdown?agent=x', '/api/spend/summary?range=1y', '/api/spend/export.csv?groupBy=nope', '/api/spend/export.csv?from=2024-01-01&to=2026-01-01']) {
    const r = await call('GET', p);
    assert.equal(r.status, 400, p);
    assert.ok(r.json.error, p);
  }
  const bad = await call('PUT', '/api/spend/prices', { provider: 'openai', model: 'gpt-4o', inPerM: 'cheap', outPerM: 1 });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.issues[0].path, 'inPerM');
  assert.equal((await call('PUT', '/api/spend/budgets', { scopeKind: 'provider', scopeKey: 'gemini', dailyUsd: 1 })).status, 400);
  assert.equal((await call('POST', '/api/spend/reprice', { days: 500 })).status, 400);
  assert.equal((await call('DELETE', '/api/spend/prices?provider=openai')).status, 400);
  assert.equal((await call('DELETE', '/api/spend/budgets/abc')).status, 400);
});

test('CSV export streams with download headers and its totals equal the breakdown totals', async () => {
  const r = await call('GET', '/api/spend/export.csv?range=7d&groupBy=feature');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/csv/);
  assert.match(r.headers['content-disposition'], /attachment; filename="ai-spend_2026-09-30_2026-10-06_feature.csv"/);
  const lines = r.text.replace(/^﻿/, '').trim().split('\r\n');
  const head = lines[0].split(',');
  const usdCol = head.indexOf('usd');
  const sum = lines.slice(1).reduce((t, l) => t + Number(l.split(',')[usdCol]), 0);
  const b = await call('GET', '/api/spend/breakdown?range=7d&groupBy=feature');
  assert.equal(sum, b.json.totals.costUsd);
  const raw = await call('GET', '/api/spend/export.csv?range=today&groupBy=raw');
  assert.match(raw.text, /^﻿id,at,provider/);
  assert.equal(raw.text.trim().split('\r\n').length, 2);
});

test('price and budget edits: upsert, delete, protected built-in rows, caches invalidated', async () => {
  const p = await call('PUT', '/api/spend/prices', { provider: 'openai', model: 'gpt-4o-mini', inPerM: 0.15, outPerM: 0.6, effectiveFrom: '2026-10-07' });
  assert.equal(p.status, 200);
  assert.equal(p.json.created, true);
  assert.equal((await call('DELETE', '/api/spend/prices?provider=openai&model=gpt-4o-mini&effectiveFrom=2026-10-07')).status, 200);
  assert.equal(invalidated.prices, 2);
  const prices = await call('GET', '/api/spend/prices');
  assert.equal(prices.json.rows[0].current, true);

  const up = await call('PUT', '/api/spend/budgets', { id: 1, scopeKind: 'global', dailyUsd: 5, enforce: false });
  assert.equal(up.status, 200);
  const created = await call('PUT', '/api/spend/budgets', { scopeKind: 'feature_prefix', scopeKey: 'strategy.', dailyUsd: 0.5, alertPct: 50 });
  assert.equal(created.json.created, true);
  assert.equal((await call('DELETE', '/api/spend/budgets/1')).status, 409);
  assert.equal((await call('DELETE', '/api/spend/budgets/2')).status, 200);
  assert.equal((await call('DELETE', '/api/spend/budgets/2')).status, 404);
  assert.equal(invalidated.budgets, 3);
  const view = await call('GET', '/api/spend/budgets');
  assert.equal(view.status, 200);
  assert.equal(view.json.rows[0].label, 'Total AI spend');
  assert.equal((await call('POST', '/api/spend/reprice', { days: 7 })).json.ok, true);
});
