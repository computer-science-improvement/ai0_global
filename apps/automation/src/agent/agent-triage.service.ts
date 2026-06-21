import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClaudeAgent } from '../common/ai/agents/claude.agent';
import { buildTriagePrompt, parseTriageResult } from './agent-triage.helpers';
import type { TriageResult } from './agent.types';

@Injectable()
export class AgentTriageService {
  constructor(
    private readonly claude: ClaudeAgent,
    private readonly config: ConfigService,
  ) {}

  async triage(messageText: string): Promise<TriageResult> {
    if (!this.claude.available) return parseTriageResult('');
    const { system, user } = buildTriagePrompt(messageText);
    const out = await this.claude.chat(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      {
        model: this.config.get<string>('AGENT_TRIAGE_MODEL') ?? undefined,
        maxTokens: Number(this.config.get<string>('AGENT_TRIAGE_MAX_TOKENS')) || 800,
      },
    );
    return parseTriageResult(out ?? '');
  }
}
