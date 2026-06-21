import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClaudeAgent } from '../common/ai/agents/claude.agent';
import { buildOpportunityPrompt, parseOpportunity } from './chat-intel.helpers';
import type { Opportunity } from './agent.types';

@Injectable()
export class AgentChatClassifier {
  constructor(private readonly claude: ClaudeAgent, private readonly config: ConfigService) {}
  async classify(text: string): Promise<Opportunity> {
    if (!this.claude.available) return parseOpportunity('');
    const { system, user } = buildOpportunityPrompt(text);
    const out = await this.claude.chat(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      { model: this.config.get<string>('AGENT_TRIAGE_MODEL') ?? undefined, maxTokens: Number(this.config.get<string>('AGENT_TRIAGE_MAX_TOKENS')) || 800 });
    return parseOpportunity(out ?? '');
  }
}
