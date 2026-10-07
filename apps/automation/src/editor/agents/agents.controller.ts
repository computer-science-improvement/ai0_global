import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { AgentsService } from './agents.service';

export const AGENTS_SERVICE = 'AGENTS_SERVICE';

/** Agent registry REST (spec 017 FR-010). Bodies are validated with zod inside AgentsService. */
@Controller('api')
@UseGuards(TrackingAuthGuard)
export class AgentsController {
  constructor(@Inject(AGENTS_SERVICE) private readonly svc: AgentsService) {}

  @Get('agents')
  tree() {
    return this.svc.tree();
  }

  // Static paths before ":handle".
  @Get('agents/inbox')
  inbox(@Query('unread') unread?: string) {
    return this.svc.inbox(unread === 'true' || unread === '1');
  }

  @Post('agents/inbox/read')
  markRead(@Body() body: unknown) {
    return this.svc.markRead(body);
  }

  @Get('agents/handles')
  handles() {
    return this.svc.handles();
  }

  @Post('agents/actions/:id/apply')
  apply(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.applyAction(id);
  }

  @Post('agents/actions/:id/discard')
  discard(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.discardAction(id);
  }

  @Get('agents/:handle')
  get(@Param('handle') handle: string) {
    return this.svc.get(handle);
  }

  @Patch('agents/:handle')
  patch(@Param('handle') handle: string, @Body() body: unknown) {
    return this.svc.patch(handle, body);
  }

  @Post('agents/:handle/run')
  run(@Param('handle') handle: string) {
    return this.svc.runNow(handle);
  }

  @Get('agents/:handle/runs')
  runs(@Param('handle') handle: string, @Query('before') before?: string, @Query('limit') limit?: string) {
    return this.svc.runs(handle, before || undefined, limit ? Number(limit) : 50);
  }

  @Get('agents/:handle/profile')
  profile(@Param('handle') handle: string) {
    return this.svc.getProfile(handle);
  }

  @Put('agents/:handle/profile')
  putProfile(@Param('handle') handle: string, @Body() body: unknown) {
    return this.svc.putProfile(handle, body);
  }

  /** Spec 024 FR-013: format_prefs of the agent's resources, owner locks and the change history. */
  @Get('agents/:handle/formatting')
  formatting(@Param('handle') handle: string) {
    return this.svc.getFormatting(handle);
  }

  @Put('agents/:handle/formatting/:ref')
  putFormatting(@Param('handle') handle: string, @Param('ref') ref: string, @Body() body: unknown) {
    return this.svc.putFormatting(handle, ref, body);
  }

  @Get('agents/:handle/memory')
  memory(@Param('handle') handle: string) {
    return this.svc.memory(handle);
  }

  @Get('agents/:handle/skills')
  skills(@Param('handle') handle: string) {
    return this.svc.listSkills(handle);
  }

  @Put('agents/:handle/skills/:name')
  putSkill(@Param('handle') handle: string, @Param('name') name: string, @Body() body: unknown) {
    return this.svc.putSkill(handle, name, body);
  }

  @Patch('agents/:handle/skills/:name')
  patchSkill(@Param('handle') handle: string, @Param('name') name: string, @Body() body: unknown) {
    return this.svc.patchSkill(handle, name, body);
  }

  @Delete('agents/:handle/skills/:name')
  deleteSkill(@Param('handle') handle: string, @Param('name') name: string) {
    return this.svc.deleteSkill(handle, name);
  }

  @Get('skills/:id/versions')
  versions(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.versions(id);
  }

  @Post('skills/:id/rollback')
  rollback(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.rollback(id, body);
  }
}
