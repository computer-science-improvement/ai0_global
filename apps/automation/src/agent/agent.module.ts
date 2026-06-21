import { Module } from '@nestjs/common';
import { AgentTriageService } from './agent-triage.service';
import { AgentInboxRepository } from './agent-inbox.repository';
import { AgentMtprotoClient } from './agent-mtproto.client';
import { AgentInboxPoller } from './agent-inbox.poller';
import { AgentController } from './agent.controller';
import { AgentActionsRepository } from './agent-actions.repository';
import { AgentReplySender } from './agent-reply-sender.service';
import { AgentScheduleExecutor } from './agent-schedule.executor';
import { AgentActionsService } from './agent-actions.service';
import { ScheduledPostsModule } from '../scheduled-posts/scheduled-posts.module';

// DB_POOL, SecretsService, ClaudeAgent, MtprotoSessionsRepository all come from
// @Global modules (DatabaseModule, CryptoModule, CommonModule, ChannelConfigModule).
// ScheduledPostsRepository is NOT global — imported via ScheduledPostsModule.
@Module({
  imports:     [ScheduledPostsModule],
  controllers: [AgentController],
  providers:   [
    AgentTriageService,
    AgentInboxRepository,
    AgentMtprotoClient,
    AgentInboxPoller,
    AgentActionsRepository,
    AgentReplySender,
    AgentScheduleExecutor,
    AgentActionsService,
  ],
  exports: [AgentInboxRepository, AgentActionsRepository],
})
export class AgentModule {}
