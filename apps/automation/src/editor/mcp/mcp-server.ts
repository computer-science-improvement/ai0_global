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
  call(args: Record<string, unknown>): Promise<unknown>;
}

/** Thrown by a tool to report a failure to the model (tool result with isError). */
export class ToolFailure extends Error {}

export interface McpServerOptions {
  name:    string;
  version: string;
  /** Shown to the user by some clients (serverInfo.title). */
  title?:  string;
  /** Returned by `initialize`: how a model should use this server (spec 103). */
  instructions?: string;
  tools:   () => Promise<McpTool[]>;
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

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

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
            capabilities:    { tools: { listChanged: false } },
            serverInfo:      { name: this.o.name, version: this.o.version, ...(this.o.title ? { title: this.o.title } : {}) },
            ...(this.o.instructions ? { instructions: this.o.instructions } : {}),
          });
        }
        case 'ping':
          return isNotification ? null : ok({});
        case 'tools/list': {
          const tools = await this.o.tools();
          return ok({
            tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({
              name, ...(title ? { title } : {}), description, inputSchema, ...(annotations ? { annotations } : {}),
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
            const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            return ok({ content: [{ type: 'text', text }], isError: false });
          } catch (err) {
            if (!(err instanceof ToolFailure)) this.o.log?.(`tool ${name} failed: ${errorText(err)}`);
            return ok({ content: [{ type: 'text', text: errorText(err) }], isError: true });
          }
        }
        default:
          if (isNotification) return null; // notifications/initialized, notifications/cancelled, …
          return fail(RPC.METHOD_NOT_FOUND, `method not found: ${method}`);
      }
    } catch (err) {
      return isNotification ? null : fail(RPC.INTERNAL, errorText(err));
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
