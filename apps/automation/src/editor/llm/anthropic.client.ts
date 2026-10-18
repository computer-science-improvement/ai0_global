import axios from 'axios';
import type { ChatMessage, LlmClient, LlmRequest, LlmResponse, ToolCall } from './llm.types';
import { ANTHROPIC_PRICES } from './model-registry';
import { llmUsage, type LlmUsageRecorder } from '../../common/ai/usage/llm-usage.service';
import { longPromptMultiplier, type EstimateResult, type TokenUsage } from '../../common/ai/usage/price.service';

type HttpPost = (url: string, body: unknown, cfg: { headers: Record<string, string>; timeout: number; signal?: AbortSignal }) => Promise<{ data: any }>;

export interface AnthropicClientOptions {
  apiKey:     string | undefined;
  baseUrl?:   string;
  timeoutMs?: number;
  /** Injected for tests; defaults to axios.post. */
  http?:      { post: HttpPost };
  sleep?:     (ms: number) => Promise<void>;
  /** Spend ledger (spec 029); defaults to the process-wide recorder. */
  usage?:     LlmUsageRecorder;
  /** llm_prices lookup (provider `anthropic`); the static ANTHROPIC_PRICES map is the fallback. */
  prices?:    { estimate(provider: string, model: string, u: TokenUsage): Promise<EstimateResult> };
  /**
   * Spec 053 FR-008: the tools breakpoint lives an hour instead of 5 minutes (2× the write price), so runs of one role
   * that start more than 5 minutes apart still read the tool block from the cache. Off unless measured worth it
   * (EDITOR_ANTHROPIC_TOOLS_CACHE_TTL=1h).
   */
  toolsCacheTtl?: '1h' | null;
}

const RETRY_DELAYS_MS = [2_000, 6_000];
const API_VERSION = '2023-06-01';
/** Thinking counts toward max_tokens on the 5.x models (adaptive thinking is on by default), so the role budgets get headroom. */
export const ANTHROPIC_MIN_MAX_TOKENS = 16_000;
const EPHEMERAL = { type: 'ephemeral' } as const;

/** Models that take `output_config.effort` (Anthropic docs, Effort, 2026-10). */
export function supportsEffort(model: string): boolean {
  return /^claude-(fable|mythos|opus|sonnet|haiku)-5(-|$)/.test(model)
    || /^claude-opus-4-[5-8]/.test(model)
    || /^claude-sonnet-4-6/.test(model);
}

const STOP_REASON: Record<string, string> = { end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_calls', max_tokens: 'length' };

function parseArgs(raw: string): unknown {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * ChatMessage[] (OpenAI shape) → Messages API `{system, messages}`.
 * - Leading system messages become the top-level system prompt; a later one becomes a user text block.
 * - An assistant turn with providerContent is sent back verbatim (thinking blocks must accompany tool_use).
 * - Tool results and the user text after them merge into one user turn (tool_result blocks first), as the API
 *   requires the results right after the assistant's tool_use turn. Consecutive turns of one role merge.
 */
export function toAnthropicMessages(msgs: readonly ChatMessage[], o: { cache?: boolean } = {}): { system: string; messages: Array<{ role: 'user' | 'assistant'; content: any[] }> } {
  const system: string[] = [];
  const out: Array<{ role: 'user' | 'assistant'; content: any[] }> = [];
  const push = (role: 'user' | 'assistant', blocks: any[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const m of msgs) {
    switch (m.role) {
      case 'system':
        if (!out.length) system.push(m.content);
        else push('user', [{ type: 'text', text: `[System note] ${m.content}` }]);
        break;
      case 'user':
        push('user', [{ type: 'text', text: m.content || '…' }]);
        break;
      case 'tool':
        push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content || '(empty)' }]);
        break;
      case 'assistant': {
        if (Array.isArray(m.providerContent) && m.providerContent.length) { push('assistant', m.providerContent as any[]); break; }
        const blocks: any[] = [];
        if (m.content && m.content.trim()) blocks.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: parseArgs(c.arguments) });
        push('assistant', blocks.length ? blocks : [{ type: 'text', text: '…' }]);
        break;
      }
    }
  }
  // The conversation must open with a user turn (a chat history may start with the agent's reply).
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: [{ type: 'text', text: '…' }] });
  // Rolling prompt-cache breakpoint on the newest block: the next step of the loop reads the whole prefix from the cache.
  const last = out[out.length - 1];
  if (last && o.cache !== false) {
    const i = last.content.length - 1;
    const b = last.content[i];
    if (b && (b.type === 'text' || b.type === 'tool_result')) last.content[i] = { ...b, cache_control: EPHEMERAL };
  }
  return { system: system.join('\n\n'), messages: out };
}

/**
 * Anthropic Messages API client (spec 038) — the Anthropic workspace's LlmClient. The request carries the
 * owner's API key (EDITOR_ANTHROPIC_API_KEY / ANTHROPIC_API_KEY); with a key of the Console org linked to a
 * Max plan, usage is paid from the plan's monthly API credits. Retries twice on 429 / 5xx / 529 / network
 * errors; any other 4xx (a bad request, an exhausted credit balance) throws at once. Temperature is not sent:
 * thinking is on by default on the 5.x models. Cost is computed from the usage (llm_prices, then
 * ANTHROPIC_PRICES), cache reads and writes at their own rates; every call writes one llm_usage row.
 */
export class AnthropicClient implements LlmClient {
  private readonly baseUrl:   string;
  private readonly timeoutMs: number;
  private readonly http:      { post: HttpPost };
  private readonly sleep:     (ms: number) => Promise<void>;

  constructor(private readonly opts: AnthropicClientOptions) {
    this.baseUrl   = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.http      = opts.http ?? { post: (u, b, c) => axios.post(u, b, c) };
    this.sleep     = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The request body (exported for tests). */
  body(req: LlmRequest): Record<string, unknown> {
    // Spec 053 FR-002: a one-call request (cache: false) sends no breakpoints — a cache write nobody reads costs 1.25×.
    const cache = req.cache !== false;
    const { system, messages } = toAnthropicMessages(req.messages, { cache });
    const toolsMark = this.opts.toolsCacheTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : EPHEMERAL;
    const tools = (req.tools ?? []).map((t, i, all) => ({
      name: t.name, description: t.description, input_schema: t.parameters,
      ...(cache && i === all.length - 1 ? { cache_control: toolsMark } : {}),
    }));
    return {
      model: req.model,
      max_tokens: Math.max(req.maxTokens ?? 0, ANTHROPIC_MIN_MAX_TOKENS),
      ...(system ? { system: [{ type: 'text', text: system, ...(cache ? { cache_control: EPHEMERAL } : {}) }] } : {}),
      messages,
      ...(tools.length ? { tools, tool_choice: { type: 'auto' } } : {}),
      ...(req.reasoningEffort && supportsEffort(req.model) ? { output_config: { effort: req.reasoningEffort } } : {}),
    };
  }

  async chat(req: LlmRequest): Promise<LlmResponse> {
    if (!this.opts.apiKey) throw new Error('The Anthropic API key is not set (EDITOR_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY)');
    const body = this.body(req);

    const tracker = (this.opts.usage ?? llmUsage()).start({ provider: 'anthropic', model: req.model });
    let data: any;
    let attempts: number;
    try {
      ({ data, attempts } = await this.postWithRetry(body, req.signal));
    } catch (err: any) {
      tracker.fail(err, { attempts: err?.attempts });
      throw err;
    }
    const u = data?.usage ?? {};
    const cacheRead  = Number(u.cache_read_input_tokens ?? 0);
    const cacheWrite = Number(u.cache_creation_input_tokens ?? 0);
    const promptTokens     = Number(u.input_tokens ?? 0) + cacheRead + cacheWrite;
    const completionTokens = Number(u.output_tokens ?? 0);
    const tokens = { tokensIn: promptTokens, tokensOut: completionTokens, tokensCachedRead: cacheRead, tokensCachedWrite: cacheWrite };

    const content: any[] = Array.isArray(data?.content) ? data.content : [];
    if (!data || data.type === 'error' || (!content.length && !data.stop_reason)) {
      const err = new Error(`Anthropic: empty response (${JSON.stringify(data)?.slice(0, 300)})`);
      tracker.fail(err, { ...tokens, attempts });
      throw err;
    }
    const text = content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
    const toolCalls: ToolCall[] = content.filter((b) => b?.type === 'tool_use').map((b) => ({
      id: String(b.id), name: String(b.name ?? ''), arguments: JSON.stringify(b.input ?? {}),
    }));

    const est = await this.opts.prices?.estimate('anthropic', req.model, tokens).catch(() => null);
    const costUsd = est?.costUsd ?? staticCost(req.model, tokens);
    tracker.ok({ ...tokens, costUsd, costSource: 'estimate', attempts });

    const stop = typeof data.stop_reason === 'string' ? data.stop_reason : null;
    return {
      message: {
        role: 'assistant', content: text || null,
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(content.length ? { providerContent: content } : {}),
      },
      finishReason: stop ? STOP_REASON[stop] ?? stop : null,
      usage: { promptTokens, completionTokens, costUsd },
    };
  }

  private async postWithRetry(body: unknown, signal?: AbortSignal): Promise<{ data: any; attempts: number }> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.http.post(`${this.baseUrl}/v1/messages`, body, {
          headers: {
            'x-api-key':         this.opts.apiKey!,
            'anthropic-version': API_VERSION,
            'content-type':      'application/json',
          },
          timeout: this.timeoutMs,
          ...(signal ? { signal } : {}),
        });
        return { data: res.data, attempts: attempt + 1 };
      } catch (err: any) {
        const status: number | undefined = err?.response?.status;
        // A cancelled request (spec 053: the caller timed out) is never retried.
        const canceled = err?.code === 'ERR_CANCELED' || signal?.aborted === true;
        const retryable = !canceled && (status === undefined || status === 429 || status >= 500);
        if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
          const detail = err?.response?.data?.error?.message ?? err?.message ?? String(err);
          throw Object.assign(new Error(`Anthropic request failed${status ? ` (${status})` : ''}: ${detail}`),
            { status, code: err?.code, attempts: attempt + 1 });
        }
        await this.sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }
}

/** USD from the static price map (unknown models: the default Sonnet price, so spend is never zero). */
export function staticCost(model: string, t: { tokensIn: number; tokensOut: number; tokensCachedRead: number; tokensCachedWrite: number }): number {
  const p = ANTHROPIC_PRICES[model] ?? ANTHROPIC_PRICES['claude-sonnet-5-5'];
  const plain = Math.max(0, t.tokensIn - t.tokensCachedRead - t.tokensCachedWrite);
  // Spec 053 FR-008: the long-prompt tier (Haiku 5.5 above 100K prompt tokens).
  const k = longPromptMultiplier(ANTHROPIC_PRICES[model] ? model : 'claude-sonnet-5-5', t.tokensIn);
  const usd = k * (plain * p.inPerM + t.tokensCachedRead * p.cacheReadPerM + t.tokensCachedWrite * p.cacheWritePerM + t.tokensOut * p.outPerM) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

/** Spec 038: one LlmClient for the editor that sends each request to its workspace's provider. */
export class RoutingLlmClient implements LlmClient {
  constructor(private readonly clients: { openrouter: LlmClient; anthropic: LlmClient }) {}

  chat(req: LlmRequest): Promise<LlmResponse> {
    return (req.provider === 'anthropic' ? this.clients.anthropic : this.clients.openrouter).chat(req);
  }
}
