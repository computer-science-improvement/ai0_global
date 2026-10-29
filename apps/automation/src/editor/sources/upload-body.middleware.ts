import type { IncomingMessage, ServerResponse } from 'http';
import { UPLOAD_BODY_LIMIT } from './upload-limits';

/**
 * Spec 076 FR-005 / A13: `POST /api/editor/sources/upload` takes a saved page (up to 5 000 000 characters, about 10 MB of
 * UTF-8), far above the global 100 KB JSON limit. This parser is mounted on the route in main.ts BEFORE Nest's own body
 * parser; it takes any JSON POST at its mount point with its own limit, and the global parser then sees `req._body` and skips.
 * A request that is not JSON passes to `next` unchanged. It is a copy of `dataRowsJsonBody`.
 */
type Req = IncomingMessage & { body?: unknown; _body?: boolean; url?: string };

function fail(res: ServerResponse, status: number, code: string, message: string) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ statusCode: status, code, message }));
}

const tooLarge = `the body is larger than ${UPLOAD_BODY_LIMIT / 1024 / 1024} MB`;

export function uploadPageJsonBody(req: Req, res: ServerResponse, next: (err?: unknown) => void): void {
  if (req.method !== 'POST' || !/\bjson\b/i.test(String(req.headers['content-type'] ?? ''))) {
    next();
    return;
  }
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > UPLOAD_BODY_LIMIT) { fail(res, 413, 'too_large', tooLarge); req.resume(); return; }
  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c: Buffer) => {
    if (aborted) return;
    size += c.length;
    if (size > UPLOAD_BODY_LIMIT) {
      aborted = true;
      fail(res, 413, 'too_large', tooLarge);
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    try {
      const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
      req.body = text.trim() ? JSON.parse(text) : undefined;
      req._body = true;
      next();
    } catch {
      fail(res, 400, 'invalid', 'the body is not valid JSON');
    }
  });
  req.on('error', (err) => { if (!aborted) next(err); });
}
