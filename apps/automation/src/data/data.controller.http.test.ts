/**
 * HTTP-level test of the /api/data endpoints the dashboard uses (spec 032 T5/T6) on an in-process Nest app
 * bound to 127.0.0.1: the real TrackingAuthGuard (makeAuth), routing and the English 4xx bodies.
 * The pool is a fake; the SQL itself is covered by data-query.pg.test.ts.
 */
import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AuthService } from '../auth/auth.service';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { makeAuth } from '../auth/testing/fakes';
import { DB_POOL } from '../database/database.tokens';
import { DataController } from './data.controller';
import { BOOKS } from './testing/books-schema';

const TOKEN = 'test-token';
const queries: string[] = [];
const pool = {
  query: async (sql: string) => {
    queries.push(sql);
    if (/FROM data_schemas WHERE key = \$1/.test(sql)) return { rows: [BOOKS] };
    if (/count\(\*\)::int AS n/.test(sql)) return { rows: [{ n: 1 }] };
    if (/FROM data_items d WHERE/.test(sql)) return { rows: [{ id: '7', title: 'Кобзар', data: { isbn: '1', title: 'Кобзар' }, posted_count: 0 }] };
    if (/FROM pending_actions/.test(sql)) return { rows: [] };
    return { rows: [] };
  },
};

let app: INestApplication;
let port: number;

before(async () => {
  Reflect.defineMetadata('design:paramtypes', [AuthService], TrackingAuthGuard);
  @Module({
    controllers: [DataController],
    providers: [
      { provide: AuthService, useValue: makeAuth({ TRACKING_TOKEN: TOKEN }).auth },
      { provide: DB_POOL, useValue: pool },
    ],
  })
  class TestModule {}
  app = await NestFactory.create(TestModule, { logger: false });
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
      res.on('end', () => { let json: any = null; try { json = JSON.parse(buf); } catch { /* empty */ } resolve({ status: res.statusCode ?? 0, json }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('every data endpoint the dashboard calls requires the login', async () => {
  for (const [m, p] of [
    ['GET', '/api/data/schemas'], ['GET', '/api/data/schemas/books'], ['POST', '/api/data/schemas'], ['PATCH', '/api/data/schemas/books'],
    ['POST', '/api/data/schemas/books/preview'], ['GET', '/api/data/books/items'], ['PATCH', '/api/data/books/items/7'],
    ['POST', '/api/data/stats/refresh'], ['GET', '/api/data/imports'], ['POST', '/api/data/imports/x/undo'],
  ]) {
    assert.equal((await call(m, p, undefined, null)).status, 401, `${m} ${p}`);
  }
});

test('items: rows with a data:// ref and the total; bad filters are a readable 400', async () => {
  const ok = await call('GET', `/api/data/books/items?filters=${encodeURIComponent(JSON.stringify([{ field: 'genre', op: 'eq', value: 'novel' }]))}&page=1&page_size=10`);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.total, 1);
  assert.equal(ok.json.items[0].ref, 'data://books/7');
  const bad = await call('GET', `/api/data/books/items?filters=${encodeURIComponent(JSON.stringify([{ field: 'title', op: 'eq', value: 'x' }]))}`);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'field_not_filterable');
  assert.match(bad.json.message, /"title" of "books" is not filterable/);
  assert.equal((await call('GET', '/api/data/books/items?page_size=1000')).status, 400);
  assert.equal((await call('PATCH', '/api/data/books/items/7', { status: 'gone' })).status, 400);
});
