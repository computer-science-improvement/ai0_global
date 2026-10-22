import axios from 'axios';
import type { ChatMessage, LlmClient, LlmRequest, LlmResponse, ToolCall } from './llm.types';
import { estimateCostUsd, resolveModel } from './model-registry';
import { llmUsage, type LlmUsageRecorder } from '../../common/ai/usage/llm-usage.service';
import type { EstimateResult, TokenUsage } from '../../common/ai/usage/price.service';

type HttpPost = (url: string, body: unknown, cfg: { headers: Record<string, string>; timeout: number; signal?: AbortSignal }) => Promise<{ data: any }>;

export interface OpenRouterClientOptions {
  apiKey:    string | undefined;
  baseUrl?:  string;
  timeoutMs?: number;
  /** Injected for tests; defaults to axios.post. */
  http?:     { post: HttpPost };
  sleep?:    (ms: number) => Promise<void>;
  /** Spend ledger (spec 029); defaults to the process-wide recorder. */
  usage?:    LlmUsageRecorder;
  /** llm_prices lookup for the fallback estimate when usage.cost is absent. */
  prices?:   { estimate(provider: string, model: string, u: TokenUsage): Promise<EstimateResult> };
}

const RETRY_DELAYS_MS = [1_000, 3_000];

/**
 * Spec 053 FR-009: models OpenRouter caches only when the request marks `cache_control` (Anthropic, Gemini). Others
 * (GLM, DeepSeek, OpenAI…) cache a repeated prefix by themselves.
 */
export function needsCacheMarks(model: string): boolean {
  return /^(anthropic|google)\//.test(model);
}

const EPHEMERAL = { type: 'ephemeral' } as const;

/**
 * Wire messages with the Anthropic-client breakpoints: the system prompt and a rolling one on the newest user / tool
 * message, so the next step of the loop reads the whole prefix (tools included) from the cache.
 */
export function withCacheMarks(wire: Array<Record<string, unknown>>, o: { rolling?: boolean } = {}): Array<Record<string, unknown>> {
  const out = wire.map((m) => ({ ...m }));
  const mark = (m: Record<string, unknown>) => {
    if (typeof m.content === 'string' && m.content) m.content = [{ type: 'text', text: m.content, cache_control: EPHEMERAL }];
  };
  const sys = out.find((m) => m.role === 'system');
  if (sys) mark(sys);
  const last = out[out.length - 1];
  if (o.rolling !== false && last && (last.role === 'user' || last.role === 'tool')) mark(last);
  return out;
}

/**
 * OpenRouter chat-completions client (OpenAI wire format). Retries twice on
 * 429 / 5xx / network errors; any other 4xx is a caller bug and throws at once.
 * Cost comes from usage.cost (always present on OpenRouter); llm_prices and
 * then the registry PRICES map are only fallbacks for other OpenAI-compatible
 * endpoints. Every call (ok, error, timeout) writes one llm_usage row; the
 * editor AgentLoop supplies the attribution context (spec 029).
 */
export class OpenRouterClient implements LlmClient {
  private readonly baseUrl:   string;
  private readonly timeoutMs: number;
  private readonly http:      { post: HttpPost };
  private readonly sleep:     (ms: number) => Promise<void>;

  constructor(private readonly opts: OpenRouterClientOptions) {
    this.baseUrl   = (opts.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.http      = opts.http ?? { post: (u, b, c) => axios.post(u, b, c) };
    this.sleep     = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async chat(req: LlmRequest): Promise<LlmResponse> {
    if (!this.opts.apiKey) throw new Error('OPENROUTER_API_KEY is not set');

    const wire = req.messages.map(toWireMessage);
    const body: Record<string, unknown> = {
      model:    req.model,
      messages: req.cache !== false && needsCacheMarks(req.model) ? withCacheMarks(wire, { rolling: req.cache !== 'prefix' }) : wire,
      ...(req.tools?.length ? {
        tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        tool_choice: 'auto',
        // Route only to providers of this model that support every parameter we
        // send (tools above all) — otherwise OpenRouter may pick a provider that
        // silently ignores tools and the loop degrades to plain text.
        provider: { require_parameters: true },
      } : {}),
      ...(req.maxTokens   !== undefined ? { max_tokens:  req.maxTokens }   : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.reasoningEffort ? { reasoning: { effort: req.reasoningEffort } } : {}),
    };

    const tracker = (this.opts.usage ?? llmUsage()).start({ provider: 'openrouter', model: req.model });
    let data: any;
    let attempts: number;
    try {
      ({ data, attempts } = await this.postWithRetry(body, req.signal));
    } catch (err: any) {
      tracker.fail(err, { attempts: err?.attempts });
      throw err;
    }
    const promptTokens     = Number(data?.usage?.prompt_tokens ?? 0);
    const completionTokens = Number(data?.usage?.completion_tokens ?? 0);
    const details          = data?.usage?.prompt_tokens_details;
    const cachedTokens     = typeof details?.cached_tokens === 'number' ? details.cached_tokens : null;
    // Spec 053 FR-009: cache writes (Anthropic / Gemini via OpenRouter) in the ledger, like the Anthropic workspace.
    const cacheWrite       = typeof details?.cache_write_tokens === 'number' ? details.cache_write_tokens : null;
    const tokens = data?.usage ? { tokensIn: promptTokens, tokensOut: completionTokens, tokensCachedRead: cachedTokens, ...(cacheWrite !== null ? { tokensCachedWrite: cacheWrite } : {}) } : {};

    const choice = data?.choices?.[0];
    if (!choice?.message) {
      const err = new Error(`OpenRouter: empty response (${JSON.stringify(data)?.slice(0, 300)})`);
      tracker.fail(err, { ...tokens, attempts, ...(typeof data?.usage?.cost === 'number' ? { costUsd: data.usage.cost } : {}) });
      throw err;
    }

    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((c: any) => ({
      id:        String(c.id),
      name:      String(c.function?.name ?? ''),
      arguments: typeof c.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {}),
    }));

    let costUsd: number;
    if (typeof data.usage?.cost === 'number') {
      costUsd = data.usage.cost;
      tracker.ok({ ...tokens, costUsd, attempts });
    } else {
      const est = await this.opts.prices?.estimate('openrouter', req.model, { tokensIn: promptTokens, tokensOut: completionTokens, tokensCachedRead: cachedTokens })
        .catch(() => null);
      costUsd = est?.costUsd ?? estimateCostUsd(resolveModel('executor', () => req.model), promptTokens, completionTokens);
      tracker.ok({ ...tokens, costUsd, costSource: 'estimate', attempts });
    }

    return {
      message: { role: 'assistant', content: choice.message.content ?? null, ...(toolCalls.length ? { toolCalls } : {}) },
      finishReason: choice.finish_reason ?? null,
      usage: { promptTokens, completionTokens, costUsd },
    };
  }

  private async postWithRetry(body: unknown, signal?: AbortSignal): Promise<{ data: any; attempts: number }> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.http.post(`${this.baseUrl}/chat/completions`, body, {
          headers: {
            Authorization:  `Bearer ${this.opts.apiKey}`,
            'Content-Type': 'application/json',
            'X-Title':      'ai0_global editor',
          },
          timeout: this.timeoutMs,
          ...(signal ? { signal } : {}),
        });
        return { data: res.data, attempts: attempt + 1 };
      } catch (err: any) {
        const status: number | undefined = err?.response?.status;
        const canceled = err?.code === 'ERR_CANCELED' || signal?.aborted === true;
        const retryable = !canceled && (status === undefined || status === 429 || status >= 500);
        if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
          const detail = err?.response?.data?.error?.message ?? err?.message ?? String(err);
          // status / code / attempts let the spend ledger classify the failure (error vs timeout).
          throw Object.assign(new Error(`OpenRouter request failed${status ? ` (${status})` : ''}: ${detail}`),
            { status, code: err?.code, attempts: attempt + 1 });
        }
        await this.sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls?.length ? {
          tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        } : {}),
      };
    default:
      return { role: m.role, content: m.content };
  }
}
