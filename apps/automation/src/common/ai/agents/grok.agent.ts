import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAiCompatibleAgent } from './openai-compatible.agent';
import { AiLoggerService } from '../ai-logger.service';

@Injectable()
export class GrokAgent extends OpenAiCompatibleAgent implements OnModuleInit {
  protected readonly logger       = new Logger(GrokAgent.name);
  protected readonly apiKey:        string | undefined;
  protected readonly baseUrl      = 'https://api.x.ai/v1';
  protected readonly defaultModel = 'grok-3';
  protected readonly agentName    = 'grok';

  constructor(
    private readonly config: ConfigService,
    aiLogger: AiLoggerService,
  ) {
    super();
    this.apiKey   = this.config.get<string>('GROK_API_KEY');
    this.aiLogger = aiLogger;
  }

  onModuleInit() {
    this.logger.log(this.available ? 'Grok agent ready' : 'GROK_API_KEY not set — agent inactive');
  }
}
