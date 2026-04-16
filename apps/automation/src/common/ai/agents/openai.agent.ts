import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAiCompatibleAgent } from './openai-compatible.agent';
import { AiLoggerService } from '../ai-logger.service';

@Injectable()
export class OpenAiAgent extends OpenAiCompatibleAgent implements OnModuleInit {
  protected readonly logger       = new Logger(OpenAiAgent.name);
  protected readonly apiKey:        string | undefined;
  protected readonly baseUrl      = 'https://api.openai.com/v1';
  protected readonly defaultModel = 'gpt-4o';
  protected readonly agentName    = 'openai';

  constructor(
    private readonly config: ConfigService,
    aiLogger: AiLoggerService,
  ) {
    super();
    this.apiKey   = this.config.get<string>('OPENAI_API_KEY');
    this.aiLogger = aiLogger;
  }

  onModuleInit() {
    this.logger.log(this.available ? 'OpenAI agent ready' : 'OPENAI_API_KEY not set — agent inactive');
  }
}
