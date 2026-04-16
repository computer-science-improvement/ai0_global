import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { AiChatMessage, AiChatOptions } from './agent.interface';
import { AiLoggerService } from '../ai-logger.service';

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
    if (!this.client) {
      this.logger.warn('Claude agent inactive');
      return null;
    }

    const model  = options?.model ?? this.defaultModel;
    const system = messages.find((m) => m.role === 'system')?.content;
    const conv   = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const start = Date.now();
    try {
      const res = await this.client.messages.create({
        model,
        max_tokens: options?.maxTokens ?? 1024,
        ...(system ? { system } : {}),
        messages: conv,
      });

      const block  = res.content[0];
      const output = block.type === 'text' ? block.text : null;
      await this.aiLogger.log({ agent: 'claude', model, status: 'success', input: messages, output, durationMs: Date.now() - start });
      return output;
    } catch (err) {
      this.logger.error(`Chat failed: ${err.message}`);
      await this.aiLogger.log({ agent: 'claude', model, status: 'error', input: messages, error: err.message, durationMs: Date.now() - start });
      return null;
    }
  }
}
