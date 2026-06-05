import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { TrackingService } from './tracking.service';
import { TrackingAuthGuard } from './tracking-auth.guard';
import { AddChannelDto } from './dto/add-channel.dto';
import { PollTier } from '../types';

class PatchChannelDto {
  @IsOptional() @IsString() @MaxLength(200)   title?:         string | null;
  @IsOptional() @IsBoolean()                  isMine?:        boolean;
  @IsOptional() @IsUUID()                     botId?:         string | null;
  @IsOptional() @IsString() @MaxLength(120)   channelKey?:    string | null;
  @IsOptional() @IsString() @MaxLength(40)    tgChatId?:      string | null;
  @IsOptional() @IsIn(['public', 'private'])  kind?:          'public' | 'private' | null;
  @IsOptional() @IsIn(['hot', 'warm', 'cold']) pollTier?:     PollTier;
  @IsOptional() @IsArray() @IsString({ each: true }) themes?: string[];
  @IsOptional() @IsBoolean()                  publishPaused?: boolean;
}

class CreateFullChannelDto {
  @IsString() @IsIn(['public', 'private'])    kind!:        'public' | 'private';
  @IsOptional() @IsString() @MaxLength(120)   channelKey?:  string;
  @IsOptional() @IsString() @MaxLength(60)    username?:    string;
  @IsOptional() @IsString() @MaxLength(40)    tgChatId?:    string;
  @IsOptional() @IsString() @MaxLength(200)   title?:       string;
  @IsOptional() @IsUUID()                     botId?:       string | null;
  @IsOptional() @IsBoolean()                  isMine?:      boolean;
  @IsOptional() @IsIn(['hot', 'warm', 'cold']) pollTier?:   PollTier;
}

@Controller('tracking')
@UseGuards(TrackingAuthGuard)
export class TrackingController {
  constructor(private readonly service: TrackingService) {}

  @Get('channels')
  list(
    @Query('filter') filter: 'mine' | 'all' | 'external' = 'all',
    @Query('q') q?: string,
    @Query('tier') tier?: PollTier,
    @Query('bot') bot?: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '50',
  ) {
    return this.service.listChannels(
      filter, q, tier,
      parseInt(page, 10), parseInt(pageSize, 10),
      bot,
    );
  }

  @Post('channels')
  add(@Body() dto: AddChannelDto) { return this.service.addChannel(dto.username); }

  /**
   * Create a channel from a full config (for private channels and any case
   * where the operator already has the bot/chat-id mapping). The discovery
   * flow above takes a single @username and resolves the rest via polling.
   */
  @Post('channels/full')
  createFull(@Body() dto: CreateFullChannelDto) {
    return this.service.createFullChannel(dto);
  }

  @Get('channels/:id')
  one(@Param('id', new ParseUUIDPipe()) id: string) { return this.service.getChannel(id); }

  @Patch('channels/:id')
  patch(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() patch: PatchChannelDto,
  ) {
    return this.service.patchChannel(id, patch);
  }

  @Delete('channels/:id')
  remove(@Param('id', new ParseUUIDPipe()) id: string) { return this.service.deleteChannel(id); }

  /** On-demand poll: enqueue an immediate meta + posts fetch for this channel. */
  @Post('channels/:id/poll')
  poll(@Param('id', new ParseUUIDPipe()) id: string) { return this.service.pollNow(id); }

  @Get('channels/:id/posts')
  posts(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('from') from?: string, @Query('to') to?: string,
    @Query('limit') limit = '50', @Query('offset') offset = '0',
  ) {
    return this.service.listPosts(id,
      from ? new Date(from) : null, to ? new Date(to) : null,
      parseInt(limit, 10), parseInt(offset, 10));
  }

  @Get('channels/:id/subs-history')
  subs(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('from') from?: string, @Query('to') to?: string,
  ) {
    return this.service.subsHistory(id, from ? new Date(from) : null, to ? new Date(to) : null);
  }

  @Get('channels/:id/top-posts')
  top(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('metric') metric: 'views' | 'reactions' | 'forwards' = 'views',
    @Query('limit') limit = '10',
  ) {
    return this.service.topPosts(id, metric, parseInt(limit, 10));
  }

  @Get('graph')
  graph(
    @Query('from') from?: string, @Query('to') to?: string,
    @Query('min_edge_weight') minWeight = '1',
    @Query('kind') kind?: string | string[],
    @Query('include_mine') includeMine = 'true',
  ) {
    const kinds = Array.isArray(kind) ? kind : (kind ? [kind] : undefined);
    return this.service.graph({
      from: from ? new Date(from) : null,
      to:   to   ? new Date(to)   : null,
      minWeight: parseInt(minWeight, 10),
      kinds,
      includeMine: includeMine !== 'false',
    });
  }

  @Get('roi/:id')
  roi(@Param('id', new ParseUUIDPipe()) id: string, @Query('fresh') fresh?: string) {
    return this.service.roi(id, fresh === 'true');
  }

  @Get('edges/:sourceId/:targetUsername/posts')
  edgePosts(
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
    @Param('targetUsername') targetUsername: string,
  ) {
    return this.service.edgePosts(sourceId, targetUsername);
  }

  @Get('discovery')
  discovery() { return this.service.discovery(); }
}
