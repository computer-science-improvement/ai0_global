import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { AgentInboxRepository } from './agent-inbox.repository';
import { AgentMtprotoClient } from './agent-mtproto.client';
import { AgentActionsRepository } from './agent-actions.repository';
import { AgentActionsService } from './agent-actions.service';
import { PatchThreadDto } from './dto/patch-thread.dto';
import { CreateActionDto } from './dto/create-action.dto';
import type { AgentActionStatus, AgentCategory } from './agent.types';

@Controller('api/agent')
@UseGuards(TrackingAuthGuard)
export class AgentController {
  constructor(
    private readonly repo:        AgentInboxRepository,
    private readonly client:      AgentMtprotoClient,
    private readonly config:      ConfigService,
    private readonly actionsRepo: AgentActionsRepository,
    private readonly actionsSvc:  AgentActionsService,
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
}
