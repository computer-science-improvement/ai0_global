import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { uploadPageJsonBody } from './upload-body.middleware';
import { UPLOAD_BODY_LIMIT } from './upload-page';

const MB = 1024 * 1024;

/** A request and a response that only record what the middleware does to them. */
function fake(headers: Record<string, string>, method = 'POST') {
  const req: any = new EventEmitter();
  req.method = method;
  req.url = '/';
  req.headers = headers;
  req.resumed = false;
  req.resume = () => { req.resumed = true; };
  const res: any = { statusCode: 200, headers: {} as Record<string, string>, ended: null as string | null };
  res.setHeader = (k: string, v: string) => { res.headers[k.toLowerCase()] = v; };
  res.end = (s: string) => { res.ended = s; };
  const calls: unknown[][] = [];
  const next = (...a: unknown[]) => { calls.push(a); };
  return { req, res, next, calls };
}

const json = (res: any) => JSON.parse(res.ended);

test('the limit is 12 MB', () => {
  assert.equal(UPLOAD_BODY_LIMIT, 12 * MB);
});

test('a declared length over the limit is a 413 before any byte is read', () => {
  const { req, res, next, calls } = fake({ 'content-type': 'application/json', 'content-length': String(UPLOAD_BODY_LIMIT + 1) });
  uploadPageJsonBody(req, res, next);
  assert.equal(res.statusCode, 413);
  assert.deepEqual(json(res), { statusCode: 413, code: 'too_large', message: 'the body is larger than 12 MB' });
  assert.equal(req.resumed, true, 'the rest of the request is drained');
  assert.equal(calls.length, 0, 'the route is not reached');
});

test('a streamed body over the limit is a 413 as soon as it passes the limit', () => {
  const { req, res, next, calls } = fake({ 'content-type': 'application/json' });
  uploadPageJsonBody(req, res, next);
  req.emit('data', Buffer.alloc(7 * MB, 0x61));
  assert.equal(res.ended, null, 'under the limit nothing is answered');
  req.emit('data', Buffer.alloc(7 * MB, 0x61));
  assert.equal(res.statusCode, 413);
  assert.equal(json(res).code, 'too_large');
  req.emit('data', Buffer.alloc(MB, 0x61));
  req.emit('end');
  assert.equal(calls.length, 0, 'the route is not reached, and the answer is sent once');
});

test('bad JSON is a 400', () => {
  const { req, res, next, calls } = fake({ 'content-type': 'application/json; charset=utf-8' });
  uploadPageJsonBody(req, res, next);
  req.emit('data', Buffer.from('{"url": '));
  req.emit('end');
  assert.equal(res.statusCode, 400);
  assert.deepEqual(json(res), { statusCode: 400, code: 'invalid', message: 'the body is not valid JSON' });
  assert.equal(calls.length, 0);
});

test('a request that is not JSON passes to next untouched', () => {
  for (const [headers, method] of [[{ 'content-type': 'text/plain' }, 'POST'], [{}, 'POST'], [{ 'content-type': 'application/json' }, 'GET']] as const) {
    const { req, res, next, calls } = fake({ ...headers }, method);
    uploadPageJsonBody(req, res, next);
    assert.deepEqual(calls, [[]], `${method} ${JSON.stringify(headers)}`);
    assert.equal(req._body, undefined);
    assert.equal(req.body, undefined);
    assert.equal(res.ended, null);
  }
});

test('a JSON body is parsed (a BOM is dropped) and marked so the global parser skips it', () => {
  const { req, res, next, calls } = fake({ 'content-type': 'application/json' });
  uploadPageJsonBody(req, res, next);
  req.emit('data', Buffer.from('\uFEFF{"url":"https://example.com/a",'));
  req.emit('data', Buffer.from('"content":"привіт"}'));
  req.emit('end');
  assert.deepEqual(calls, [[]]);
  assert.equal(req._body, true);
  assert.deepEqual(req.body, { url: 'https://example.com/a', content: 'привіт' });
});

test('an empty body is let through with no body at all', () => {
  const { req, res, next, calls } = fake({ 'content-type': 'application/json' });
  uploadPageJsonBody(req, res, next);
  req.emit('end');
  assert.deepEqual(calls, [[]]);
  assert.equal(req.body, undefined);
  assert.equal(req._body, true);
});

// ── over a real socket: a 6 MB body reaches the route, a 13 MB one gets 413 ───────────────────────────────────────────

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server: Server = createServer((req, res) => {
    uploadPageJsonBody(req as any, res, () => {
      const body = (req as any).body;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ reached: true, chars: String(body?.content ?? '').length }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  }
}

test('over HTTP a 6 MB page reaches the route and a 13 MB one gets 413', async () => {
  await withServer(async (base) => {
    const post = (chars: number) => fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/a', content: 'a'.repeat(chars) }),
    });
    const ok = await post(6 * MB);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { reached: true, chars: 6 * MB });
    const big = await post(13 * MB);
    assert.equal(big.status, 413);
    assert.equal(((await big.json()) as any).code, 'too_large');
  });
});
