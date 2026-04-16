import { Logger } from '@nestjs/common';
import axios from 'axios';
import { AiChatMessage, AiChatOptions } from './agent.interface';
import { AiLoggerService } from '../ai-logger.service';

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

  async chat(messages: AiChatMessage[], options?: AiChatOptions): Promise<string | null> {
    if (!this.apiKey) {
      this.logger.warn('API key not set — agent inactive');
      return null;
    }

    const model = options?.model ?? this.defaultModel;
    const start = Date.now();

    try {
      const res = await axios.post(
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

      const output = res.data?.choices?.[0]?.message?.content ?? null;
      await this.aiLogger?.log({ agent: this.agentName, model, status: 'success', input: messages, output, durationMs: Date.now() - start });
      return output;
    } catch (err) {
      this.logger.error(`Chat failed: ${err.message}`);
      await this.aiLogger?.log({ agent: this.agentName, model, status: 'error', input: messages, error: err.message, durationMs: Date.now() - start });
      return null;
    }
  }
}
