import { Logger } from '@nestjs/common';
import axios from 'axios';
import { AiChatMessage, AiChatOptions } from './agent.interface';
import { AiLoggerService } from '../ai-logger.service';
import { isBudgetExceeded, llmUsage } from '../usage/llm-usage.service';
import type { LlmProvider } from '../usage/llm-prices.repository';

/** Spend-ledger provider of each OpenAI-compatible agent (spec 029). */
const PROVIDER_BY_AGENT: Record<string, LlmProvider> = { openai: 'openai', perplexity: 'perplexity', grok: 'xai' };

/**
 * Base for any OpenAI-compatible chat completions API
 * (OpenAI, Perplexity, Grok, etc.).
 */
export abstract class OpenAiCompatibleAgent {
  protected abstract readonly logger: Logger;
  protected abstract readonly apiKey: string | undefined;
  protected abstract readonly baseUrl: string;
  protected abstract readonly defaultModel: string;
  protected abstract readonly agentName: string;
  protected aiLogger?: AiLoggerService;

  get available(): boolean {
    return !!this.apiKey;
  }

  /** The HTTP call (a seam for tests). */
  protected post(url: string, body: unknown, cfg: { headers: Record<string, string>; timeout: number }): Promise<{ data: any }> {
    return axios.post(url, body, cfg);
  }

  async chat(messages: AiChatMessage[], options?: AiChatOptions): Promise<string | null> {
    if (!this.apiKey) {
      this.logger.warn('API key not set — agent inactive');
      return null;
    }

    const model = options?.model ?? this.defaultModel;
    const provider = PROVIDER_BY_AGENT[this.agentName] ?? 'openai';
    const usage = llmUsage();
    const explicit = options?.feature ? { feature: options.feature } : {};
    // Blocking spend caps (spec 029 FR-008): a refused call takes the same null path as a failed one.
    try {
      await usage.guard(provider, explicit);
    } catch (err: any) {
      if (isBudgetExceeded(err)) {
        this.logger.warn(`Chat refused: ${err.message}`);
        return null;
      }
      this.logger.warn(`Budget check failed, call proceeds: ${err?.message ?? err}`);
    }
    const start = Date.now();
    const tracker = usage.start({ provider, model, ...explicit });

    try {
      const res = await this.post(
        `${this.baseUrl}/chat/completions`,
        {
          model,
          messages,
          ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
        },
        {
          headers: {
            Authorization:  `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30_000,
        },
      );

      const u = res.data?.usage;
      tracker.ok({
        tokensIn:         typeof u?.prompt_tokens === 'number' ? u.prompt_tokens : null,
        tokensOut:        typeof u?.completion_tokens === 'number' ? u.completion_tokens : null,
        tokensCachedRead: u?.prompt_tokens_details?.cached_tokens ?? null,
      });
      const output = res.data?.choices?.[0]?.message?.content ?? null;
      await this.aiLogger?.log({ agent: this.agentName, model, status: 'success', input: messages, output, durationMs: Date.now() - start });
      return output;
    } catch (err) {
      tracker.fail(err);
      this.logger.error(`Chat failed: ${err.message}`);
      await this.aiLogger?.log({ agent: this.agentName, model, status: 'error', input: messages, error: err.message, durationMs: Date.now() - start });
      return null;
    }
  }
}
