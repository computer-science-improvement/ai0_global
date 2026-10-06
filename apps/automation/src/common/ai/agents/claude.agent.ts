import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { AiChatMessage, AiChatOptions } from './agent.interface';
import { AiLoggerService } from '../ai-logger.service';
import { isBudgetExceeded, llmUsage } from '../usage/llm-usage.service';

@Injectable()
export class ClaudeAgent implements OnModuleInit {
  private readonly logger       = new Logger(ClaudeAgent.name);
  private client:                 Anthropic | null = null;
  readonly defaultModel         = 'claude-haiku-4-5-20251001';

  constructor(
    private readonly config:    ConfigService,
    private readonly aiLogger:  AiLoggerService,
  ) {}

  onModuleInit() {
    const key = this.config.get<string>('ANTHROPIC_API_KEY');
    if (key) {
      this.client = new Anthropic({ apiKey: key });
      this.logger.log('Claude agent ready');
    } else {
      this.logger.warn('ANTHROPIC_API_KEY not set — agent inactive');
    }
  }

  get available(): boolean {
    return !!this.client;
  }

  async chat(messages: AiChatMessage[], options?: AiChatOptions): Promise<string | null> {
    return (await this.chatWithMeta(messages, options)).text;
  }

  /**
   * chat() plus the model's stop_reason ('end_turn' | 'max_tokens' | …), so a
   * caller can tell a complete answer from one cut off at the token cap.
   * `text` is null on failure / inactive agent (stopReason null then).
   */
  async chatWithMeta(
    messages: AiChatMessage[],
    options?: AiChatOptions,
  ): Promise<{ text: string | null; stopReason: string | null }> {
    if (!this.client) {
      this.logger.warn('Claude agent inactive');
      return { text: null, stopReason: null };
    }

    const model  = options?.model ?? this.defaultModel;
    const system = messages.find((m) => m.role === 'system')?.content;
    const conv   = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const usage    = llmUsage();
    const explicit = options?.feature ? { feature: options.feature } : {};
    // Blocking spend caps (spec 029 FR-008): a refused call takes the same null path as a failed one.
    try {
      await usage.guard('anthropic', explicit);
    } catch (err: any) {
      if (isBudgetExceeded(err)) {
        this.logger.warn(`Chat refused: ${err.message}`);
        return { text: null, stopReason: null };
      }
      this.logger.warn(`Budget check failed, call proceeds: ${err?.message ?? err}`);
    }
    const start = Date.now();
    const tracker = usage.start({ provider: 'anthropic', model, ...explicit });
    try {
      const res = await this.client.messages.create({
        model,
        max_tokens: options?.maxTokens ?? 1024,
        // NOTE: Anthropic prompt caching (cache_control on the system block)
        // would cut repeated-call cost here, but the pinned @anthropic-ai/sdk
        // version's TextBlockParam type doesn't support it yet — deferred to an
        // SDK upgrade so it can be verified against the live API.
        ...(system ? { system } : {}),
        messages: conv,
      });

      // The pinned SDK types lack the cache fields, but the API returns them.
      const u = res.usage as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
      const cachedRead  = u?.cache_read_input_tokens ?? 0;
      const cachedWrite = u?.cache_creation_input_tokens ?? 0;
      tracker.ok({
        // Anthropic's input_tokens excludes cache reads/writes; the ledger's tokens_in counts all prompt tokens.
        tokensIn: (u?.input_tokens ?? 0) + cachedRead + cachedWrite, tokensOut: u?.output_tokens ?? 0,
        tokensCachedRead: cachedRead, tokensCachedWrite: cachedWrite,
      });

      const block  = res.content[0];
      const output = block.type === 'text' ? block.text : null;
      await this.aiLogger.log({ agent: 'claude', model, status: 'success', input: messages, output, durationMs: Date.now() - start });
      return { text: output, stopReason: res.stop_reason ?? null };
    } catch (err) {
      tracker.fail(err);
      this.logger.error(`Chat failed: ${err.message}`);
      await this.aiLogger.log({ agent: 'claude', model, status: 'error', input: messages, error: err.message, durationMs: Date.now() - start });
      return { text: null, stopReason: null };
    }
  }
}
