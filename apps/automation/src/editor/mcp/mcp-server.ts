import { createInterface } from 'readline';
import type { Readable, Writable } from 'stream';

/**
 * Minimal, dependency-free MCP server over stdio (spec 006 T012).
 *
 * Implements the subset Claude Code needs: `initialize`, `ping`, `tools/list`
 * and `tools/call`, as JSON-RPC 2.0 messages, one JSON object per line
 * (the MCP stdio transport). Notifications get no response. stdout carries
 * protocol messages only; diagnostics go to the `log` callback (stderr).
 */

/** MCP tool annotations (spec 2025-06-18+): hints a client uses to decide when to ask the user before a call. */
export interface McpToolAnnotations {
  title?:           string;
  readOnlyHint?:    boolean;
  destructiveHint?: boolean;
  idempotentHint?:  boolean;
  openWorldHint?:   boolean;
}

export interface McpTool {
  name:         string;
  /** Human-readable name (spec 103: every connector tool has one). */
  title?:       string;
  description:  string;
  inputSchema:  Record<string, unknown>;
  annotations?: McpToolAnnotations;
  /** Tool metadata for tools/list (`_meta`), e.g. the MCP Apps `ui.resourceUri` of its view (spec 104). */
  _meta?: Record<string, unknown>;
  call(args: Record<string, unknown>): Promise<unknown>;
  /**
   * MCP Apps (spec 104): the `structuredContent` a view renders for a successful call, built after `call` from its
   * arguments and result. Null, a failure or a timeout leaves the call text-only. The text result is never changed by it.
   */
  view?(args: Record<string, unknown>, result: unknown): Promise<Record<string, unknown> | null>;
}

/** What `resources/read` returns for one resource (MCP `TextResourceContents`; `_meta` carries e.g. the MCP Apps CSP). */
export interface McpResourceContent {
  text:   string;
  _meta?: Record<string, unknown>;
}

/** A readable resource (spec 104: the MCP Apps `ui://` views). */
export interface McpResource {
  uri:          string;
  name:         string;
  title?:       string;
  description?: string;
  mimeType:     string;
  _meta?:       Record<string, unknown>;
  /** Other URIs this resource also answers (an older cache-busting version a host still holds). */
  matches?(uri: string): boolean;
  read(): Promise<McpResourceContent>;
}

/** An icon of the server (MCP 2025-11-25 `Icon`). */
export interface McpIcon {
  src:       string;
  mimeType?: string;
  /** e.g. ['48x48'], or ['any'] for SVG. */
  sizes?:    string[];
}

/** Thrown by a tool to report a failure to the model (tool result with isError). */
export class ToolFailure extends Error {}

export interface McpServerOptions {
  name:    string;
  version: string;
  /** Shown to the user by some clients (serverInfo.title). */
  title?:  string;
  /** serverInfo.icons and serverInfo.websiteUrl (MCP 2025-11-25): absolute https URLs a client may show as the server's logo. */
  icons?:  McpIcon[];
  websiteUrl?: string;
  /** Returned by `initialize`: how a model should use this server (spec 103). */
  instructions?: string;
  tools:   () => Promise<McpTool[]>;
  /** Readable resources (spec 104). Unset: no `resources` capability and resources/* are unknown methods, as before. */
  resources?: () => Promise<McpResource[]>;
  /**
   * Remote endpoints: serialise results compactly and keep each under this many characters (over budget → a cut result
   * with `truncated: true` and a hint). Unset (stdio): pretty-printed and unbounded, as before.
   */
  maxResultChars?: number;
  /** A view's structuredContent over this many characters (compact JSON) is left out, and the call stays text-only. */
  maxStructuredChars?: number;
  /** How long a tool's `view` may take before the call is answered text-only (default 10 s). */
  viewTimeoutMs?: number;
  log?:    (msg: string) => void;
}

type JsonRpcId = string | number | null;
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id:      JsonRpcId;
  result?: unknown;
  error?:  { code: number; message: string; data?: unknown };
}

/** Newest first: an unknown requested version is answered with the first one. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const RPC = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 } as const;

/** MCP's error code for a `resources/read` of an unknown URI. */
export const RESOURCE_NOT_FOUND = -32002;

const VIEW_TIMEOUT_MS = 10_000;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const TRUNCATION_HINT = 'The result was too large and was cut to fit. Ask for less: a smaller limit, a narrower filter, or fewer items (for a run, only its first steps are kept).';

/** Longest array (by compact JSON length) with more than one item anywhere in the tree; the parent holder lets the caller cut it. */
function longestArray(node: unknown, best: { len: number; arr: unknown[] | null } = { len: 0, arr: null }): { len: number; arr: unknown[] | null } {
  if (Array.isArray(node)) {
    if (node.length > 1) { const len = JSON.stringify(node).length; if (len > best.len) { best.len = len; best.arr = node; } }
    for (const x of node) longestArray(x, best);
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) longestArray(v, best);
  }
  return best;
}

/** Compact JSON text of a tool result, at most `max` characters. A bigger result is cut (arrays halved, then long strings clipped) and marked. */
export function fitResult(result: unknown, max: number): string {
  const first = typeof result === 'string' ? result : JSON.stringify(result);
  if (first.length <= max) return first;
  if (typeof result === 'string') return JSON.stringify({ truncated: true, hint: TRUNCATION_HINT, text: result.slice(0, Math.max(0, max - 400)) }).slice(0, max);
  const copy = JSON.parse(first);
  const root: Record<string, unknown> = Array.isArray(copy) ? { items: copy } : (copy && typeof copy === 'object' ? copy : { value: copy });
  root.truncated = true;
  root.hint = TRUNCATION_HINT;
  for (let i = 0; i < 60; i++) {
    const text = JSON.stringify(root);
    if (text.length <= max) return text;
    const { arr } = longestArray(root);
    if (arr) { arr.length = Math.max(1, Math.floor(arr.length / 2)); continue; }
    break;
  }
  // No array left to cut: clip long strings, then give up on structure.
  const clip = (n: unknown, cap: number): unknown => {
    if (typeof n === 'string') return n.length > cap ? `${n.slice(0, cap)}…` : n;
    if (Array.isArray(n)) return n.map((x) => clip(x, cap));
    if (n && typeof n === 'object') return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, clip(v, cap)]));
    return n;
  };
  for (const cap of [4000, 1000, 300, 100]) {
    const text = JSON.stringify(clip(root, cap));
    if (text.length <= max) return text;
  }
  return JSON.stringify({ truncated: true, hint: TRUNCATION_HINT, text: first.slice(0, Math.max(0, max - 400)) }).slice(0, max);
}

export class McpServer {
  constructor(private readonly o: McpServerOptions) {}

  /** Handle one parsed message. Returns the response, or null for notifications. */
  async handle(msg: unknown): Promise<JsonRpcResponse | null> {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || (msg as any).jsonrpc !== '2.0' || typeof (msg as any).method !== 'string') {
      const id = (msg as any)?.id ?? null;
      return { jsonrpc: '2.0', id, error: { code: RPC.INVALID_REQUEST, message: 'invalid JSON-RPC request' } };
    }
    const { id, method, params } = msg as { id?: JsonRpcId; method: string; params?: any };
    const isNotification = id === undefined;
    const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id: id ?? null, result });
    const fail = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

    try {
      switch (method) {
        case 'initialize': {
          const requested = params?.protocolVersion;
          return ok({
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
            capabilities:    { tools: { listChanged: false }, ...(this.o.resources ? { resources: { listChanged: false } } : {}) },
            serverInfo:      {
              name: this.o.name, version: this.o.version,
              ...(this.o.title ? { title: this.o.title } : {}),
              ...(this.o.icons?.length ? { icons: this.o.icons } : {}),
              ...(this.o.websiteUrl ? { websiteUrl: this.o.websiteUrl } : {}),
            },
            ...(this.o.instructions ? { instructions: this.o.instructions } : {}),
          });
        }
        case 'ping':
          return isNotification ? null : ok({});
        case 'tools/list': {
          const tools = await this.o.tools();
          return ok({
            tools: tools.map(({ name, title, description, inputSchema, annotations, _meta }) => ({
              name, ...(title ? { title } : {}), description, inputSchema, ...(annotations ? { annotations } : {}), ...(_meta ? { _meta } : {}),
            })),
          });
        }
        case 'tools/call': {
          const name = params?.name;
          const args = params?.arguments ?? {};
          if (typeof name !== 'string' || typeof args !== 'object' || Array.isArray(args)) {
            return fail(RPC.INVALID_PARAMS, 'tools/call needs {name, arguments}');
          }
          const tool = (await this.o.tools()).find((t) => t.name === name);
          if (!tool) return fail(RPC.INVALID_PARAMS, `unknown tool: ${name}`);
          try {
            const result = await tool.call(args);
            const text = this.o.maxResultChars ? fitResult(result, this.o.maxResultChars) : typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            const structuredContent = tool.view ? await this.viewOf(tool, args, result) : null;
            return ok({ content: [{ type: 'text', text }], ...(structuredContent ? { structuredContent } : {}), isError: false });
          } catch (err) {
            if (!(err instanceof ToolFailure)) this.o.log?.(`tool ${name} failed: ${errorText(err)}`);
            return ok({ content: [{ type: 'text', text: errorText(err) }], isError: true });
          }
        }
        case 'resources/list':
        case 'resources/templates/list':
        case 'resources/read': {
          if (!this.o.resources) return isNotification ? null : fail(RPC.METHOD_NOT_FOUND, `method not found: ${method}`);
          const resources = await this.o.resources();
          if (method === 'resources/list') {
            return ok({
              resources: resources.map(({ uri, name, title, description, mimeType, _meta }) => ({
                uri, name, ...(title ? { title } : {}), ...(description ? { description } : {}), mimeType, ...(_meta ? { _meta } : {}),
              })),
            });
          }
          if (method === 'resources/templates/list') return ok({ resourceTemplates: [] });
          const uri = params?.uri;
          if (typeof uri !== 'string') return fail(RPC.INVALID_PARAMS, 'resources/read needs {uri}');
          const res = resources.find((r) => r.uri === uri) ?? resources.find((r) => r.matches?.(uri));
          if (!res) return fail(RESOURCE_NOT_FOUND, `resource not found: ${uri.slice(0, 200)}`);
          const content = await res.read();
          return ok({ contents: [{ uri, mimeType: res.mimeType, text: content.text, ...(content._meta ? { _meta: content._meta } : {}) }] });
        }
        default:
          if (isNotification) return null; // notifications/initialized, notifications/cancelled, …
          return fail(RPC.METHOD_NOT_FOUND, `method not found: ${method}`);
      }
    } catch (err) {
      return isNotification ? null : fail(RPC.INTERNAL, errorText(err));
    }
  }

  /** A tool's view content, or null: a failure, a timeout or an oversized view never fails the call (spec 104). */
  private async viewOf(tool: McpTool, args: Record<string, unknown>, result: unknown): Promise<Record<string, unknown> | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const view = await Promise.race([
        tool.view!(args, result),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.o.viewTimeoutMs ?? VIEW_TIMEOUT_MS); }),
      ]);
      if (!view || typeof view !== 'object' || Array.isArray(view)) return null;
      const max = this.o.maxStructuredChars;
      if (max && JSON.stringify(view).length > max) { this.o.log?.(`tool ${tool.name}: view left out (over ${max} characters)`); return null; }
      return view;
    } catch (err) {
      this.o.log?.(`tool ${tool.name}: view failed: ${errorText(err)}`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Serve newline-delimited JSON-RPC on the given streams (stdin/stdout in production). */
  attach(input: Readable, output: Writable): Promise<void> {
    const send = (m: JsonRpcResponse) => output.write(`${JSON.stringify(m)}\n`);
    const rl = createInterface({ input, crlfDelay: Infinity });
    const pending = new Set<Promise<void>>();
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: unknown;
      try { msg = JSON.parse(line); } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: RPC.PARSE, message: 'parse error' } });
        return;
      }
      // Requests are handled concurrently: a long run_slot must not block ping.
      const p = this.handle(msg).then((res) => { if (res) send(res); }).catch((err) => this.o.log?.(`unhandled: ${errorText(err)}`));
      pending.add(p);
      void p.finally(() => pending.delete(p));
    });
    return new Promise((resolve) => rl.on('close', () => { void Promise.all(pending).then(() => resolve()); }));
  }
}
