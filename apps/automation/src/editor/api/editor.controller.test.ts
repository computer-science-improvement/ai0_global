/**
 * HTTP-level test of EditorController on a throwaway in-process Nest app bound
 * to 127.0.0.1 with a stub EditorOpsService: routing, the real TrackingAuthGuard,
 * and the same global ValidationPipe as main.ts (which must pass `unknown`
 * bodies through so zod can validate them). No DB, no external network.
 */
import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../../auth/auth.service';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { EDITOR_OPS, EditorController } from './editor.controller';

const TOKEN = 'test-token';
const calls: Array<[string, ...unknown[]]> = [];
const rec = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); return { ok: name }; };
const ops = {
  listChannels: rec('listChannels'), getChannel: rec('getChannel'), upsertChannel: rec('upsertChannel'),
  replan: rec('replan'), listMemory: rec('listMemory'), addMemory: rec('addMemory'), retireMemory: rec('retireMemory'),
  listPlans: rec('listPlans'), getSlot: rec('getSlot'), runSlot: rec('runSlot'), skipSlot: rec('skipSlot'),
  listRuns: rec('listRuns'), getRun: rec('getRun'), spend: rec('spend'), listTools: rec('listTools'), callTool: rec('callTool'),
};

let app: INestApplication;
let port: number;

before(async () => {
  // tsx/esbuild emits no decorator metadata; restore what `nest build` (tsc) emits for the guard.
  Reflect.defineMetadata('design:paramtypes', [ConfigService, AuthService], TrackingAuthGuard);
  // `@Body() body: unknown` compiles to Object — the ValidationPipe must leave it alone.
  for (const m of ['upsert', 'addMemory', 'callTool', 'skipSlot']) {
    Reflect.defineMetadata('design:paramtypes', [String, Object], EditorController.prototype, m);
  }
  @Module({
    controllers: [EditorController],
    providers: [
      { provide: ConfigService, useValue: { get: (k: string) => ({ TRACKING_TOKEN: TOKEN } as any)[k] } },
      { provide: AuthService, useValue: { verifyToken: async () => null } },
      { provide: EDITOR_OPS, useValue: ops },
    ],
  })
  class TestModule {}
  app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
  await app.listen(0, '127.0.0.1');
  port = (app.getHttpServer().address() as AddressInfo).port;
});
after(async () => { await app?.close(); });

function call(method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port, method, path,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-type': 'application/json' } : {}) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: buf ? JSON.parse(buf) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const SLOT = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

test('requires the tracking token', async () => {
  assert.equal((await call('GET', '/api/editor/channels', undefined, null)).status, 401);
  assert.equal((await call('GET', '/api/editor/channels', undefined, 'wrong')).status, 401);
  assert.equal((await call('GET', '/api/editor/channels')).status, 200);
});

test('routes reach the ops service with decoded params, raw bodies and query flags', async () => {
  calls.length = 0;
  await call('PUT', '/api/editor/channels/%40my_chan', { mode: 'shadow', unknownField: 1 });
  await call('POST', '/api/editor/channels/%40my_chan/replan?wait=true');
  await call('POST', `/api/editor/slots/${SLOT}/run`);
  await call('POST', `/api/editor/slots/${SLOT}/skip`, { reason: 'дубль' });
  await call('DELETE', '/api/editor/channels/%40my_chan/memory/7');
  await call('GET', '/api/editor/plans?date=2026-10-01&channel=%40my_chan');
  await call('GET', '/api/editor/runs?channel=%40my_chan&limit=5');
  await call('GET', '/api/editor/spend?days=7');
  await call('POST', '/api/editor/tools/lint_post', { channel: '@my_chan', input: { spec: {} } });
  assert.deepEqual(calls, [
    ['upsertChannel', '@my_chan', { mode: 'shadow', unknownField: 1 }],  // zod (not class-validator) rejects unknown keys
    ['replan', '@my_chan', { wait: true }],
    ['runSlot', SLOT, { wait: false }],
    ['skipSlot', SLOT, 'дубль'],
    ['retireMemory', '@my_chan', 7],
    ['listPlans', '2026-10-01', '@my_chan'],
    ['listRuns', { channel: '@my_chan', slot: undefined, limit: '5' }],
    ['spend', '7'],
    ['callTool', 'lint_post', { channel: '@my_chan', input: { spec: {} } }],
  ]);
});

test('malformed ids are rejected before reaching the service', async () => {
  calls.length = 0;
  assert.equal((await call('POST', '/api/editor/slots/not-a-uuid/run')).status, 400);
  assert.equal((await call('GET', '/api/editor/runs/123')).status, 400);
  assert.equal((await call('DELETE', '/api/editor/channels/x/memory/abc')).status, 400);
  assert.deepEqual(calls, []);
});
