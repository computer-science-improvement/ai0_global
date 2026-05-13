import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import { TrackingAuthGuard } from './tracking-auth.guard';
import { AddChannelDto } from './dto/add-channel.dto';
import { PollTier } from '../types';

@Controller('tracking')
@UseGuards(TrackingAuthGuard)
export class TrackingController {
  constructor(private readonly service: TrackingService) {}

  @Get('channels')
  list(
    @Query('filter') filter: 'mine' | 'all' | 'external' = 'all',
    @Query('q') q?: string,
    @Query('tier') tier?: PollTier,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '50',
  ) {
    return this.service.listChannels(filter, q, tier, parseInt(page, 10), parseInt(pageSize, 10));
  }

  @Post('channels')
  add(@Body() dto: AddChannelDto) { return this.service.addChannel(dto.username); }

  @Get('channels/:id')
  one(@Param('id', new ParseUUIDPipe()) id: string) { return this.service.getChannel(id); }

  @Delete('channels/:id')
  remove(@Param('id', new ParseUUIDPipe()) id: string) { return this.service.deleteChannel(id); }

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
  ) {
    return this.service.graph(
      from ? new Date(from) : null, to ? new Date(to) : null,
      parseInt(minWeight, 10),
    );
  }

  @Get('roi/:id')
  roi(@Param('id', new ParseUUIDPipe()) id: string) { return this.service.roi(id); }

  @Get('discovery')
  discovery() { return this.service.discovery(); }
}
