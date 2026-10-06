import { z } from 'zod';
import { McpTool, ToolFailure } from './mcp-server';

/**
 * MCP tools for operating the editor network (spec 006 T012). Every tool
 * goes through the REST API (`/api/editor/*`, TRACKING_TOKEN): the MCP process
 * never touches the database and has no publish path of its own.
 *
 * Safety (constitution V):
 *   • set_mode accepts off|shadow only — switching to live stays human-only (dashboard).
 *   • run_slot runs shadow channels only, unless allowLiveRun (EDITOR_MCP_ALLOW_LIVE_RUN=true).
 *   • the editor's read tools are proxied through POST /api/editor/tools/:name,
 *     which only executes tools of kind `read`.
 */

export interface EditorApi {
  get(path: string): Promise<any>;
  post(path: string, body?: unknown): Promise<any>;
  put(path: string, body: unknown): Promise<any>;
}

export class HttpEditorApi implements EditorApi {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, private readonly token: string, o: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 300_000; // replan/run with wait=true can take minutes
  }

  get(path: string) { return this.request('GET', path); }
  post(path: string, body?: unknown) { return this.request('POST', path, body); }
  put(path: string, body: unknown) { return this.request('PUT', path, body); }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const url = `${this.base}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: any) {
      throw new ToolFailure(`editor API unreachable (${method} ${url}): ${err?.message ?? err}`);
    }
    const text = await res.text();
    if (!res.ok) throw new ToolFailure(`editor API ${res.status} on ${method} ${path}: ${text.slice(0, 2000)}`);
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  }
}

interface ToolOptions {
  /** Let run_slot execute slots of live channels (EDITOR_MCP_ALLOW_LIVE_RUN=true). */
  allowLiveRun?: boolean;
  log?: (msg: string) => void;
}

const enc = encodeURIComponent;
const uuid = z.string().uuid();
const channel = z.string().min(1).max(200).describe('Channel key, e.g. "@my_channel" (see list_channels)');

function schemaOf(s: z.ZodType): Record<string, unknown> {
  const j = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete j.$schema;
  return j;
}

function parse<S extends z.ZodType>(s: S, args: unknown): z.infer<S> {
  const r = s.safeParse(args);
  if (!r.success) throw new ToolFailure(`invalid arguments: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  return r.data;
}

function tool<S extends z.ZodObject<any>>(name: string, description: string, input: S, run: (a: z.infer<S>) => Promise<unknown>): McpTool {
  return { name, description, inputSchema: schemaOf(input), call: async (args) => run(parse(input, args)) };
}

const qs = (o: Record<string, string | number | undefined>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${enc(String(v))}`);
  return p.length ? `?${p.join('&')}` : '';
};

function ownerTools(api: EditorApi, o: ToolOptions): McpTool[] {
  return [
    tool('list_channels', 'All editor channel cards with mode, today\'s slot counts and spend, and whether the editor is enabled.',
      z.object({}), () => api.get('/api/editor/channels')),

    tool('get_channel', 'One channel card (brief, formats, hashtags, limits, sources, skills) with today\'s stats.',
      z.object({ channel }), ({ channel: c }) => api.get(`/api/editor/channels/${enc(c)}`)),

    tool('list_memory', 'Channel memory: owner rules, reviewer insights, things to avoid (active and retired, plus mode-change audit).',
      z.object({ channel }), ({ channel: c }) => api.get(`/api/editor/channels/${enc(c)}/memory`)),

    tool('list_plans', 'Day plans with their slots (time, format, topic, status, preview). Date defaults to today (Kyiv).',
      z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'), channel: channel.optional() }),
      ({ date, channel: c }) => api.get(`/api/editor/plans${qs({ date, channel: c })}`)),

    tool('get_slot', 'One slot: status, PostSpec, rendered preview, error, run id.',
      z.object({ slot_id: uuid }), ({ slot_id }) => api.get(`/api/editor/slots/${slot_id}`)),

    tool('list_runs', 'Recent agent runs (planner/executor/reviewer) with status, steps, tokens and cost.',
      z.object({ channel: channel.optional(), slot_id: uuid.optional(), limit: z.number().int().min(1).max(200).optional() }),
      ({ channel: c, slot_id, limit }) => api.get(`/api/editor/runs${qs({ channel: c, slot: slot_id, limit })}`)),

    tool('get_run', 'A run trace: every LLM turn and tool call with args, result, tokens and $.',
      z.object({ run_id: uuid }), ({ run_id }) => api.get(`/api/editor/runs/${run_id}`)),

    tool('get_spend', 'LLM spend in USD per Kyiv day per channel.',
      z.object({ days: z.number().int().min(1).max(90).default(7) }), ({ days }) => api.get(`/api/editor/spend${qs({ days })}`)),

    tool('replan', 'Run the planner for a channel now (supersedes today\'s plan; its planned slots are skipped). Waits for the run.',
      z.object({ channel }), ({ channel: c }) => api.post(`/api/editor/channels/${enc(c)}/replan?wait=true`)),

    tool('run_slot',
      'Execute one planned slot now through the normal executor and all publish guards. Shadow channels only: the post is rendered and stored, never published.',
      z.object({ slot_id: uuid }),
      async ({ slot_id }) => {
        const slot = await api.get(`/api/editor/slots/${slot_id}`);
        const card = await api.get(`/api/editor/channels/${enc(slot.channelKey)}`);
        if (card.mode !== 'shadow' && !o.allowLiveRun) {
          throw new ToolFailure(`run_slot is shadow-only: ${slot.channelKey} is in mode "${card.mode}". Ask the owner to run it from the dashboard.`);
        }
        return api.post(`/api/editor/slots/${slot_id}/run?wait=true`);
      }),

    liveIsHumanOnly(tool('set_mode', 'Switch a channel to off or shadow (a safety stop). Approval mode and live are human-only: the owner switches them in the dashboard.',
      z.object({ channel, mode: z.enum(['off', 'shadow']) }),
      async ({ channel: c, mode }) => {
        await api.get(`/api/editor/channels/${enc(c)}`); // unknown channel → 404 → ToolFailure; never creates a card
        return api.put(`/api/editor/channels/${enc(c)}`, { mode });
      })),
  ];
}

/** A clear refusal for mode=live (instead of a bare enum validation error). */
function liveIsHumanOnly(t: McpTool): McpTool {
  return {
    ...t,
    call: async (args) => {
      if (args?.mode === 'live') throw new ToolFailure('set_mode live is human-only: the owner switches a channel to live in the dashboard (/app/editor).');
      if (args?.mode === 'approve') throw new ToolFailure('set_mode approve is human-only: the owner switches a channel to approval mode in the dashboard (/app/editor).');
      return t.call(args);
    },
  };
}

interface RemoteTool { name: string; description: string; parameters: Record<string, any>; roles?: string[] }

/** Wrap one editor read tool: same schema plus a required `channel`, executed by the REST API. */
function proxyReadTool(api: EditorApi, t: RemoteTool): McpTool {
  const params = t.parameters ?? {};
  const props = { ...(params.properties ?? {}) };
  delete props.channel;
  return {
    name: t.name,
    description: `${t.description} (editor read tool; runs in the context of the given channel)`,
    inputSchema: {
      type: 'object',
      properties: { channel: { type: 'string', description: 'Channel key, e.g. "@my_channel"' }, ...props },
      required: ['channel', ...((params.required ?? []) as string[]).filter((r) => r !== 'channel')],
    },
    call: async (args) => {
      const { channel: c, ...input } = args;
      if (typeof c !== 'string' || !c) throw new ToolFailure('invalid arguments: channel is required');
      return api.post(`/api/editor/tools/${enc(t.name)}`, { channel: c, input });
    },
  };
}

export async function buildEditorMcpTools(api: EditorApi, o: ToolOptions = {}): Promise<McpTool[]> {
  const owner = ownerTools(api, o);
  const ownerNames = new Set(owner.map((t) => t.name));
  let remote: RemoteTool[] = [];
  try {
    remote = await api.get('/api/editor/tools');
  } catch (err: any) {
    o.log?.(`could not load editor read tools (${err?.message ?? err}); serving owner tools only`);
  }
  return [...owner, ...remote.filter((t) => !ownerNames.has(t.name)).map((t) => proxyReadTool(api, t))];
}
