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
import { AgentChatClassifier } from './agent-chat-classifier.service';
import { AgentMonitoredChatsRepository } from './agent-monitored-chats.repository';
import { AgentOpportunitiesRepository } from './agent-opportunities.repository';
import { AgentChatPoller } from './agent-chat.poller';
import { ScheduledPostsModule } from '../scheduled-posts/scheduled-posts.module';
import { AuthModule } from '../auth/auth.module';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';

// DB_POOL, SecretsService, ClaudeAgent, MtprotoSessionsRepository all come from
// @Global modules (DatabaseModule, CryptoModule, CommonModule, ChannelConfigModule).
// ScheduledPostsRepository is NOT global — imported via ScheduledPostsModule.
// AuthModule (exports AuthService) is required because AgentController is guarded
// by TrackingAuthGuard, which injects AuthService — same pattern as SettingsModule.
@Module({
  imports:     [ScheduledPostsModule, AuthModule],
  controllers: [AgentController],
  providers:   [
    TrackingAuthGuard,
    AgentTriageService,
    AgentInboxRepository,
    AgentMtprotoClient,
    AgentInboxPoller,
    AgentActionsRepository,
    AgentReplySender,
    AgentScheduleExecutor,
    AgentActionsService,
    AgentChatClassifier,
    AgentMonitoredChatsRepository,
    AgentOpportunitiesRepository,
    AgentChatPoller,
  ],
  exports: [AgentInboxRepository, AgentActionsRepository],
})
export class AgentModule {}
