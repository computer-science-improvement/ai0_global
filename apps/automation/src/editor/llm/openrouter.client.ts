import axios from 'axios';
import type { ChatMessage, LlmClient, LlmRequest, LlmResponse, ToolCall } from './llm.types';
import { estimateCostUsd, resolveModel } from './model-registry';

type HttpPost = (url: string, body: unknown, cfg: { headers: Record<string, string>; timeout: number }) => Promise<{ data: any }>;

export interface OpenRouterClientOptions {
  apiKey:    string | undefined;
  baseUrl?:  string;
  timeoutMs?: number;
  /** Injected for tests; defaults to axios.post. */
  http?:     { post: HttpPost };
  sleep?:    (ms: number) => Promise<void>;
}

const RETRY_DELAYS_MS = [1_000, 3_000];

/**
 * OpenRouter chat-completions client (OpenAI wire format). Retries twice on
 * 429 / 5xx / network errors; any other 4xx is a caller bug and throws at once.
 * Cost comes from usage.cost (always present on OpenRouter); the registry
 * price is only a fallback for other OpenAI-compatible endpoints.
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

    const data = await this.postWithRetry(body);
    const choice = data?.choices?.[0];
    if (!choice?.message) throw new Error(`OpenRouter: empty response (${JSON.stringify(data)?.slice(0, 300)})`);

    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((c: any) => ({
      id:        String(c.id),
      name:      String(c.function?.name ?? ''),
      arguments: typeof c.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {}),
    }));

    const promptTokens     = Number(data.usage?.prompt_tokens ?? 0);
    const completionTokens = Number(data.usage?.completion_tokens ?? 0);
    const costUsd = typeof data.usage?.cost === 'number'
      ? data.usage.cost
      : estimateCostUsd(resolveModel('executor', () => req.model), promptTokens, completionTokens);

    return {
      message: { role: 'assistant', content: choice.message.content ?? null, ...(toolCalls.length ? { toolCalls } : {}) },
      finishReason: choice.finish_reason ?? null,
      usage: { promptTokens, completionTokens, costUsd },
    };
  }

  private async postWithRetry(body: unknown): Promise<any> {
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
        return res.data;
      } catch (err: any) {
        const status: number | undefined = err?.response?.status;
        const retryable = status === undefined || status === 429 || status >= 500;
        if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
          const detail = err?.response?.data?.error?.message ?? err?.message ?? String(err);
          throw new Error(`OpenRouter request failed${status ? ` (${status})` : ''}: ${detail}`);
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
