import {
  Controller, Get, Param, Post, Query, UseGuards, ParseIntPipe,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags,
} from '@nestjs/swagger';
import { ApiKeyGuard }           from './api-key.guard';
import { StatsService }          from './stats.service';
import { StatsCollectorService } from './stats-collector.service';
import {
  ChannelDetailDto,
  ChannelSummaryDto,
  PostDetailDto,
  PostWithLatestDto,
  RefreshResultDto,
  SummaryDto,
} from './dto/stats.dto';

@ApiTags('stats')
@ApiHeader({ name: 'X-API-Key', required: true })
@UseGuards(ApiKeyGuard)
@Controller('stats')
export class StatsController {
  constructor(
    private readonly stats:     StatsService,
    private readonly collector: StatsCollectorService,
  ) {}

  @Get('channels')
  @ApiOperation({ summary: 'List channels with latest subscribers + 24h delta' })
  @ApiOkResponse({ type: [ChannelSummaryDto] })
  async channels(): Promise<ChannelSummaryDto[]> {
    return this.stats.channelsSummary() as any;
  }

  @Get('channels/:channelId')
  @ApiOperation({ summary: 'Channel subscriber timeseries' })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'ISO date' })
  @ApiQuery({ name: 'to',   required: false, type: String, description: 'ISO date' })
  @ApiOkResponse({ type: ChannelDetailDto })
  async channelDetail(
    @Param('channelId') channelId: string,
    @Query('from') from?: string,
    @Query('to')   to?:   string,
  ): Promise<ChannelDetailDto> {
    const snapshots = await this.stats.channelTimeseries(
      channelId,
      from ? new Date(from) : undefined,
      to   ? new Date(to)   : undefined,
    );
    return { channelId, snapshots } as any;
  }

  @Get('channels/:channelId/posts')
  @ApiOperation({ summary: 'Posts of a channel with latest metrics' })
  @ApiQuery({ name: 'limit',  required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiOkResponse({ type: [PostWithLatestDto] })
  async channelPosts(
    @Param('channelId') channelId: string,
    @Query('limit')  limit  = '20',
    @Query('offset') offset = '0',
  ): Promise<PostWithLatestDto[]> {
    const lim = Math.max(1, Math.min(parseInt(limit, 10) || 20, 200));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    return this.stats.postsByChannel(channelId, lim, off) as any;
  }

  @Get('posts/:postId')
  @ApiOperation({ summary: 'Full post + metrics timeseries' })
  @ApiOkResponse({ type: PostDetailDto })
  async postDetail(
    @Param('postId', ParseIntPipe) postId: number,
  ): Promise<PostDetailDto> {
    const result = await this.stats.postTimeseries(postId);
    if (!result.post) throw new NotFoundException(`Post ${postId} not found`);
    return result as any;
  }

  @Get('summary')
  @ApiOperation({ summary: 'Overall dashboard summary' })
  @ApiOkResponse({ type: SummaryDto })
  async summary(): Promise<SummaryDto> {
    return this.stats.summary() as any;
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Trigger collector manually (debug)' })
  @ApiOkResponse({ type: RefreshResultDto })
  async refresh(): Promise<RefreshResultDto> {
    return this.collector.runOnce();
  }
}
