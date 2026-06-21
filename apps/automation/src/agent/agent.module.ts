import { Module } from '@nestjs/common';
import { AgentTriageService } from './agent-triage.service';
import { AgentInboxRepository } from './agent-inbox.repository';
import { AgentMtprotoClient } from './agent-mtproto.client';
import { AgentInboxPoller } from './agent-inbox.poller';
import { AgentController } from './agent.controller';

// DB_POOL, SecretsService, ClaudeAgent, MtprotoSessionsRepository all come from
// @Global modules (DatabaseModule, CryptoModule, CommonModule, ChannelConfigModule).
@Module({
  controllers: [AgentController],
  providers:   [AgentTriageService, AgentInboxRepository, AgentMtprotoClient, AgentInboxPoller],
  exports:     [AgentInboxRepository],
})
export class AgentModule {}
