import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { AgentMtprotoClient } from './agent-mtproto.client';
import { AgentChatClassifier } from './agent-chat-classifier.service';
import { AgentMonitoredChatsRepository } from './agent-monitored-chats.repository';
import { AgentOpportunitiesRepository } from './agent-opportunities.repository';
import { isOpportunityCandidate } from './chat-intel.helpers';

@Injectable()
export class AgentChatPoller {
  private readonly logger = new Logger(AgentChatPoller.name);
  constructor(
    private readonly client: AgentMtprotoClient,
    private readonly classifier: AgentChatClassifier,
    private readonly chats: AgentMonitoredChatsRepository,
    private readonly opps: AgentOpportunitiesRepository,
    private readonly config: ConfigService,
  ) {}

  @Cron(process.env.AGENT_CHAT_POLL_CRON || '*/15 * * * *')
  async tick(): Promise<void> {
    try { await this.pollOnce(); } catch (err: any) { this.logger.warn(`chat poll failed: ${err.message}`); }
  }

  async pollOnce(): Promise<{ classified: number }> {
    if (this.config.get<string>('AGENT_CHAT_ENABLED') !== 'true') return { classified: 0 };
    const max = Number(this.config.get('AGENT_CHAT_MAX')) || 20;
    const enabled = (await this.chats.enabled()).slice(0, max);
    let classified = 0;
    for (const c of enabled) {
      const since = await this.chats.lastMessageId(c.chat_id);
      const msgs = await this.client.fetchChatMessages(c.chat_id, since);
      let maxId = since;
      for (const m of msgs) {
        if (m.messageId > maxId) maxId = m.messageId;
        if (!isOpportunityCandidate(m.text)) continue;       // pre-filter BEFORE any AI
        const o = await this.classifier.classify(m.text);
        classified++;
        await this.opps.upsert({ chatId: c.chat_id, chatTitle: c.title ?? null, messageId: m.messageId, text: m.text }, o);
      }
      if (maxId > since) await this.chats.setLastMessageId(c.chat_id, maxId);
    }
    if (classified) this.logger.log(`chat-intel: classified ${classified} candidate message(s)`);
    return { classified };
  }
}
