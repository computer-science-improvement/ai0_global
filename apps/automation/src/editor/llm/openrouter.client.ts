import axios from 'axios';
import type { ChatMessage, LlmClient, LlmRequest, LlmResponse, ToolCall } from './llm.types';
import { estimateCostUsd, resolveModel } from './model-registry';
import { llmUsage, type LlmUsageRecorder } from '../../common/ai/usage/llm-usage.service';
import type { EstimateResult, TokenUsage } from '../../common/ai/usage/price.service';

type HttpPost = (url: string, body: unknown, cfg: { headers: Record<string, string>; timeout: number }) => Promise<{ data: any }>;

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

    const body: Record<string, unknown> = {
      model:    req.model,
      messages: req.messages.map(toWireMessage),
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
      ({ data, attempts } = await this.postWithRetry(body));
    } catch (err: any) {
      tracker.fail(err, { attempts: err?.attempts });
      throw err;
    }
    const promptTokens     = Number(data?.usage?.prompt_tokens ?? 0);
    const completionTokens = Number(data?.usage?.completion_tokens ?? 0);
    const cachedTokens     = typeof data?.usage?.prompt_tokens_details?.cached_tokens === 'number' ? data.usage.prompt_tokens_details.cached_tokens : null;
    const tokens = data?.usage ? { tokensIn: promptTokens, tokensOut: completionTokens, tokensCachedRead: cachedTokens } : {};

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

  private async postWithRetry(body: unknown): Promise<{ data: any; attempts: number }> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.http.post(`${this.baseUrl}/chat/completions`, body, {
          headers: {
            Authorization:  `Bearer ${this.opts.apiKey}`,
            'Content-Type': 'application/json',
            'X-Title':      'ai0_global editor',
          },
          timeout: this.timeoutMs,
        });
        return { data: res.data, attempts: attempt + 1 };
      } catch (err: any) {
        const status: number | undefined = err?.response?.status;
        const retryable = status === undefined || status === 429 || status >= 500;
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
