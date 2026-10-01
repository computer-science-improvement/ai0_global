import {
  Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { EditorOpsService } from './editor-ops.service';

export const EDITOR_OPS = 'EDITOR_OPS';

const isTrue = (v?: string) => v === 'true' || v === '1';

/**
 * Owner ops surface of the editor agent (spec 006). Bodies are plain JSON
 * validated with zod inside EditorOpsService (the global class-validator pipe
 * passes `unknown` bodies through untouched).
 *
 * Long-running actions (replan, run) start in the background and return at
 * once; `?wait=true` waits for the agent run to finish (used by the MCP server).
 */
@Controller('api/editor')
@UseGuards(TrackingAuthGuard)
export class EditorController {
  constructor(@Inject(EDITOR_OPS) private readonly ops: EditorOpsService) {}

  @Get('channels')
  channels() {
    return this.ops.listChannels();
  }

  @Get('channels/:key')
  channel(@Param('key') key: string) {
    return this.ops.getChannel(key);
  }

  @Put('channels/:key')
  upsert(@Param('key') key: string, @Body() body: unknown) {
    return this.ops.upsertChannel(key, body);
  }

  @Post('channels/:key/replan')
  replan(@Param('key') key: string, @Query('wait') wait?: string) {
    return this.ops.replan(key, { wait: isTrue(wait) });
  }

  @Get('channels/:key/memory')
  memory(@Param('key') key: string) {
    return this.ops.listMemory(key);
  }

  @Post('channels/:key/memory')
  addMemory(@Param('key') key: string, @Body() body: unknown) {
    return this.ops.addMemory(key, body);
  }

  @Delete('channels/:key/memory/:id')
  retireMemory(@Param('key') key: string, @Param('id', ParseIntPipe) id: number) {
    return this.ops.retireMemory(key, id);
  }

  @Get('plans')
  plans(@Query('date') date?: string, @Query('channel') channel?: string) {
    return this.ops.listPlans(date, channel);
  }

  @Get('slots/:id')
  slot(@Param('id', ParseUUIDPipe) id: string) {
    return this.ops.getSlot(id);
  }

  @Post('slots/:id/run')
  runSlot(@Param('id', ParseUUIDPipe) id: string, @Query('wait') wait?: string) {
    return this.ops.runSlot(id, { wait: isTrue(wait) });
  }

  @Post('slots/:id/skip')
  skipSlot(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const reason = (body as { reason?: unknown } | null)?.reason;
    return this.ops.skipSlot(id, typeof reason === 'string' ? reason : undefined);
  }

  @Get('runs')
  runs(@Query('channel') channel?: string, @Query('slot') slot?: string, @Query('limit') limit?: string) {
    return this.ops.listRuns({ channel, slot, limit });
  }

  @Get('runs/:id')
  run(@Param('id', ParseUUIDPipe) id: string) {
    return this.ops.getRun(id);
  }

  @Get('spend')
  spend(@Query('days') days?: string) {
    return this.ops.spend(days);
  }

  @Get('tools')
  tools() {
    return this.ops.listTools();
  }

  @Post('tools/:name')
  callTool(@Param('name') name: string, @Body() body: unknown) {
    return this.ops.callTool(name, body);
  }
}
