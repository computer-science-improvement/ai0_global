import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAiCompatibleAgent } from './openai-compatible.agent';
import { AiLoggerService } from '../ai-logger.service';

@Injectable()
export class PerplexityAgent extends OpenAiCompatibleAgent implements OnModuleInit {
  protected readonly logger       = new Logger(PerplexityAgent.name);
  protected readonly apiKey:        string | undefined;
  protected readonly baseUrl      = 'https://api.perplexity.ai';
  protected readonly defaultModel = 'sonar-pro';
  protected readonly agentName    = 'perplexity';

  constructor(
    private readonly config: ConfigService,
    aiLogger: AiLoggerService,
  ) {
    super();
    this.apiKey   = this.config.get<string>('PERPLEXITY_API_KEY');
    this.aiLogger = aiLogger;
  }

  onModuleInit() {
    this.logger.log(this.available ? 'Perplexity agent ready' : 'PERPLEXITY_API_KEY not set — agent inactive');
  }
}
