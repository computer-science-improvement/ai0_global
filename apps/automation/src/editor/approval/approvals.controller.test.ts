/**
 * HTTP-level test of ApprovalsController (spec 031 FR-011) on an in-process Nest
 * app bound to 127.0.0.1: the real TrackingAuthGuard, routing, raw bodies and the
 * 409 `already_decided` of a lost race. No DB, no external network.
 */
import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { ConflictException, Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../../auth/auth.service';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { makeAuth } from '../../auth/testing/fakes';
import { APPROVALS_SERVICE, ApprovalsController } from './approvals.controller';

const TOKEN = 'test-token';
const SLOT = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
const calls: Array<[string, ...unknown[]]> = [];
let approvals = 0;
const svc = {
  list: async (q: unknown) => { calls.push(['list', q]); return { items: [], waiting: 0 }; },
  count: async () => ({ waiting: 3 }),
  bulk: async (b: unknown) => { calls.push(['bulk', b]); return { approved: 2, skippedWithWarnings: 1, conflicts: 0, ids: [] }; },
  approve: async (id: string) => {
    calls.push(['approve', id]);
    if (++approvals > 1) throw new ConflictException({ error: 'already_decided', status: 'approved' });
    return { card: { id }, movedTo: null };
  },
  edit: async (id: string, b: unknown) => { calls.push(['edit', id, b]); return { card: { id }, warnings: [] }; },
  reschedule: async (id: string, b: unknown) => { calls.push(['reschedule', id, b]); return { card: { id } }; },
  reject: async (id: string, b: unknown) => { calls.push(['reject', id, b]); return { card: { id }, replacementId: null }; },
};

let app: INestApplication;
let port: number;

before(async () => {
  Reflect.defineMetadata('design:paramtypes', [AuthService], TrackingAuthGuard);
  for (const m of ['bulk']) Reflect.defineMetadata('design:paramtypes', [Object], ApprovalsController.prototype, m);
  for (const m of ['edit', 'reschedule', 'reject']) Reflect.defineMetadata('design:paramtypes', [String, Object], ApprovalsController.prototype, m);
  Reflect.defineMetadata('design:paramtypes', [Object], ApprovalsController.prototype, 'list');
  @Module({
    controllers: [ApprovalsController],
    providers: [
      { provide: ConfigService, useValue: { get: (k: string) => ({ TRACKING_TOKEN: TOKEN } as any)[k] } },
      { provide: AuthService, useValue: makeAuth({ TRACKING_TOKEN: TOKEN }).auth },
      { provide: APPROVALS_SERVICE, useValue: svc },
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

test('approvals API requires the tracking token', async () => {
  assert.equal((await call('GET', '/api/editor/approvals', undefined, null)).status, 401);
  assert.equal((await call('POST', `/api/editor/approvals/${SLOT}/approve`, undefined, 'wrong')).status, 401);
  assert.equal((await call('GET', '/api/editor/approvals/count')).json.waiting, 3);
});

test('routes reach the service; a second approve answers 409 already_decided', async () => {
  calls.length = 0;
  await call('GET', '/api/editor/approvals?status=awaiting_approval&resource=telegram%3A%40chan&from=2030-01-01T00:00:00Z');
  await call('POST', '/api/editor/approvals/bulk', { channel: '@chan', date: '2030-01-02' });
  await call('POST', `/api/editor/approvals/${SLOT}/edit`, { spec: { title: 'x' } });
  await call('POST', `/api/editor/approvals/${SLOT}/reschedule`, { at: '2030-01-02T10:00:00Z' });
  await call('POST', `/api/editor/approvals/${SLOT}/reject`, { reason: 'тема вчорашня' });
  assert.deepEqual(calls.map((c) => c[0]), ['list', 'bulk', 'edit', 'reschedule', 'reject']);
  assert.deepEqual((calls[0][1] as any).resource, 'telegram:@chan');
  assert.deepEqual(calls[2][2], { spec: { title: 'x' } }, 'raw body reaches zod');

  const first = await call('POST', `/api/editor/approvals/${SLOT}/approve`);
  const second = await call('POST', `/api/editor/approvals/${SLOT}/approve`);
  assert.equal(first.status, 201);
  assert.equal(second.status, 409);
  assert.equal(second.json.error, 'already_decided');
  assert.equal((await call('POST', '/api/editor/approvals/not-a-uuid/approve')).status, 400);
});
