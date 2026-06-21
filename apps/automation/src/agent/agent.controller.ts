import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { AgentInboxRepository } from './agent-inbox.repository';
import { AgentMtprotoClient } from './agent-mtproto.client';
import { AgentActionsRepository } from './agent-actions.repository';
import { AgentActionsService } from './agent-actions.service';
import { AgentMonitoredChatsRepository } from './agent-monitored-chats.repository';
import { AgentOpportunitiesRepository } from './agent-opportunities.repository';
import { PatchThreadDto } from './dto/patch-thread.dto';
import { CreateActionDto } from './dto/create-action.dto';
import { MonitorChatDto } from './dto/monitor-chat.dto';
import type { AgentActionStatus, AgentCategory, OpportunityKind } from './agent.types';

@Controller('api/agent')
@UseGuards(TrackingAuthGuard)
export class AgentController {
  constructor(
    private readonly repo:        AgentInboxRepository,
    private readonly client:      AgentMtprotoClient,
    private readonly config:      ConfigService,
    private readonly actionsRepo: AgentActionsRepository,
    private readonly actionsSvc:  AgentActionsService,
    private readonly chatsRepo:   AgentMonitoredChatsRepository,
    private readonly oppsRepo:    AgentOpportunitiesRepository,
  ) {}

  @Get('inbox')
  inbox(@Query('status') status?: string, @Query('category') category?: AgentCategory) {
    return this.repo.list({ status, category });
  }

  @Patch('inbox/:id')
  async patch(@Param('id') id: string, @Body() dto: PatchThreadDto) {
    await this.repo.setStatus(id, dto.status);
    return { ok: true };
  }

  @Get('status')
  async status() {
    return {
      enabled:         this.config.get<string>('AGENT_ENABLED') === 'true',
      hasAgentSession: await this.client.hasSession(),
      lastPolledAt:    await this.repo.lastPolledAt('agent'),
      cadence:         process.env.AGENT_POLL_CRON || '*/5 * * * *',
    };
  }

  @Get('actions')
  actions(@Query('status') status?: AgentActionStatus) {
    return this.actionsRepo.list(status);
  }

  @Post('actions')
  createAction(@Body() dto: CreateActionDto) {
    return this.actionsRepo.create({ type: dto.type, threadId: dto.threadId ?? null, payload: dto.payload });
  }

  @Post('actions/:id/approve')
  approveAction(@Param('id') id: string) {
    return this.actionsSvc.approve(id);
  }

  @Post('actions/:id/reject')
  rejectAction(@Param('id') id: string) {
    return this.actionsSvc.reject(id);
  }

  @Get('chats')
  async chats() {
    const [groups, monitored] = await Promise.all([this.client.listGroups(), this.chatsRepo.list()]);
    const enabledMap = new Map(monitored.map(m => [m.chat_id, m.enabled]));
    return groups.map(g => ({ chatId: g.chatId, title: g.title, enabled: enabledMap.get(g.chatId) ?? false }));
  }

  @Post('chats/:chatId/monitor')
  async monitor(@Param('chatId') chatId: string, @Body() dto: MonitorChatDto) {
    const groups = await this.client.listGroups();
    const g = groups.find(x => x.chatId === chatId);
    await this.chatsRepo.upsert(chatId, g?.title ?? chatId);
    await this.chatsRepo.setEnabled(chatId, dto.enabled);
    return { ok: true };
  }

  @Get('opportunities')
  opportunities(@Query('status') status?: string, @Query('kind') kind?: OpportunityKind) {
    return this.oppsRepo.list({ status, kind });
  }

  @Patch('opportunities/:id')
  async patchOpp(@Param('id') id: string, @Body() dto: PatchThreadDto) {
    await this.oppsRepo.setStatus(id, dto.status);
    return { ok: true };
  }
}
