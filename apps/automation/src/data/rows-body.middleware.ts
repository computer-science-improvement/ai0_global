import type { IncomingMessage, ServerResponse } from 'http';

/**
 * `POST /api/data/:schema/rows` takes up to 5 000 rows, far above the global 100 KB JSON limit. This
 * parser is mounted on /api/data in main.ts BEFORE Nest's own body parser and handles only JSON POSTs to
 * a `…/rows` path, with its own limit; the global parser then sees `req._body` and skips. Everything
 * else under /api/data keeps the default parser and limit.
 */
export const ROWS_BODY_LIMIT = 10 * 1024 * 1024;

type Req = IncomingMessage & { body?: unknown; _body?: boolean; url?: string };

function fail(res: ServerResponse, status: number, code: string, message: string) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ statusCode: status, code, message }));
}

export function dataRowsJsonBody(req: Req, res: ServerResponse, next: (err?: unknown) => void): void {
  const path = (req.url ?? '').split('?')[0];
  if (req.method !== 'POST' || !/^\/[^/]+\/rows\/?$/.test(path) || !/\bjson\b/i.test(String(req.headers['content-type'] ?? ''))) {
    next();
    return;
  }
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > ROWS_BODY_LIMIT) { fail(res, 413, 'too_large', `the body is larger than ${ROWS_BODY_LIMIT / 1024 / 1024} MB`); req.resume(); return; }
  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c: Buffer) => {
    if (aborted) return;
    size += c.length;
    if (size > ROWS_BODY_LIMIT) {
      aborted = true;
      fail(res, 413, 'too_large', `the body is larger than ${ROWS_BODY_LIMIT / 1024 / 1024} MB`);
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    try {
      const text = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
      req.body = text.trim() ? JSON.parse(text) : undefined;
      req._body = true;
      next();
    } catch {
      fail(res, 400, 'invalid', 'the body is not valid JSON');
    }
  });
  req.on('error', (err) => { if (!aborted) next(err); });
}
