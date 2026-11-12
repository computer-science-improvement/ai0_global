import type { IncomingMessage, ServerResponse } from 'http';

/**
 * POST /api/mcp takes one JSON-RPC message of up to 1 MB (Nest's default parser stops at 100 KB). Mounted on /api/mcp in
 * main.ts before Nest's own parser; the global parser then sees `req._body` and skips. A failure does not answer here:
 * the endpoint answers it after the auth checks (an unauthenticated caller learns nothing, and a connector that is off
 * stays a plain 404), so the middleware only flags it.
 */
export const MCP_BODY_LIMIT = 1024 * 1024;

export type McpBodyState = 'ok' | 'invalid_json' | 'too_large' | 'none';
type Req = IncomingMessage & { body?: unknown; _body?: boolean; mcpBody?: McpBodyState };

export function mcpJsonBody(req: Req, _res: ServerResponse, next: (err?: unknown) => void): void {
  if (req.method !== 'POST') { next(); return; }
  req._body = true; // Nest's parser must never touch this route
  const declared = Number(req.headers['content-length'] ?? 0);
  let size = 0;
  let tooLarge = declared > MCP_BODY_LIMIT;
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => {
    if (tooLarge) return; // keep draining so the connection stays usable, keep nothing
    size += c.length;
    if (size > MCP_BODY_LIMIT) { tooLarge = true; chunks.length = 0; return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (tooLarge) { req.mcpBody = 'too_large'; next(); return; }
    const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
    if (!text.trim()) { req.mcpBody = 'none'; next(); return; }
    try {
      req.body = JSON.parse(text);
      req.mcpBody = 'ok';
    } catch {
      req.mcpBody = 'invalid_json';
    }
    next();
  });
  req.on('error', (err) => next(err));
}
