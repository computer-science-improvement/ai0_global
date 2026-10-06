import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'stream';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { DataController } from './data.controller';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { dataRowsJsonBody, ROWS_BODY_LIMIT } from './rows-body.middleware';

const emptyPool = { query: async () => ({ rows: [] }) } as any;

test('the whole /api/data controller is behind TrackingAuthGuard', () => {
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, DataController), [TrackingAuthGuard]);
});

test('errors come back as English 4xx bodies', async () => {
  const c = new DataController(emptyPool);
  await assert.rejects(c.getSchema('nope'), (e: any) => e instanceof NotFoundException && /unknown dataset "nope"/.test((e.getResponse() as any).message));
  assert.throws(() => c.createSchema({ key: 'Bad Key', title: '' }, {}), BadRequestException);
  assert.throws(() => c.rows('books', { not: 'an array' }, undefined, {}), (e: any) => /JSON array/.test(e.getResponse().message));
  assert.throws(() => c.rows('books', Array.from({ length: 5001 }, () => ({})), undefined, {}), (e: any) => /at most 5000/.test(e.getResponse().message));
  assert.throws(() => c.dryRun(undefined as any, { schema: 'books' }, {}), (e: any) => /attach the file/.test(e.getResponse().message));
  assert.throws(() => c.dryRun({ buffer: Buffer.from('a'), size: 1 }, {}, {}), (e: any) => /choose the dataset/.test(e.getResponse().message));
  assert.throws(() => c.dryRun({ buffer: Buffer.from('a'), size: 1 }, { schema: 'b', mapping: '{oops' }, {}), (e: any) => /mapping must be JSON/.test(e.getResponse().message));
  assert.throws(() => c.dryRun({ buffer: Buffer.from('a'), size: 1 }, { schema: 'b', format: 'xlsx' }, {}), (e: any) => /csv, json or jsonl/.test(e.getResponse().message));
});

function fakeReq(method: string, url: string, body: string | Buffer, type = 'application/json') {
  const req: any = new PassThrough();
  req.method = method; req.url = url; req.headers = { 'content-type': type };
  setImmediate(() => req.end(body));
  return req;
}
function fakeRes() {
  const res: any = { statusCode: 200, headers: {}, body: '', setHeader(k: string, v: string) { this.headers[k] = v; }, end(b: string) { this.body = b; this.ended = true; } };
  return res;
}

test('rows body parser: JSON POSTs to …/rows only, with its own limit', async () => {
  const req = fakeReq('POST', '/books/rows?dry_run=1', '﻿[{"isbn":"1"}]');
  await new Promise<void>((resolve, reject) => dataRowsJsonBody(req, fakeRes(), (err) => (err ? reject(err) : resolve())));
  assert.deepEqual(req.body, [{ isbn: '1' }]);
  assert.equal(req._body, true, 'the global parser will skip it');

  const other = fakeReq('POST', '/schemas', '{}');
  let called = false;
  dataRowsJsonBody(other, fakeRes(), () => { called = true; });
  assert.equal(called, true);
  assert.equal(other.body, undefined, 'other routes keep the default parser');

  const bad = fakeReq('POST', '/books/rows', '{nope');
  const res = fakeRes();
  await new Promise<void>((r) => { dataRowsJsonBody(bad, res, () => r()); setTimeout(r, 50); });
  assert.equal(res.statusCode, 400);

  const big = fakeReq('POST', '/books/rows', Buffer.alloc(ROWS_BODY_LIMIT + 10, 0x20));
  const res2 = fakeRes();
  await new Promise<void>((r) => { dataRowsJsonBody(big, res2, () => r()); setTimeout(r, 100); });
  assert.equal(res2.statusCode, 413);
});
