// apps/automation/src/config/api/forward-routes.controller.ts
import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get,
  HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards,
} from '@nestjs/common';
import { IsString, IsUUID, MaxLength, IsOptional, IsNotEmpty } from 'class-validator';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { ForwardRoutesRepository } from '../forward-routes.repository';
import { ConfigCacheService } from '../config-cache.service';
import { ConfigEventsPublisher } from '../config-events.publisher';

class CreateForwardRouteDto {
  @IsUUID()
  source_channel_id!: string;

  @IsUUID()
  target_channel_id!: string;

  @IsString() @IsNotEmpty() @MaxLength(64)
  topic!: string;

  @IsOptional() @IsString() @MaxLength(500)
  description?: string;
}

/**
 * Forward routes — content that publishes into the source channel gets
 * re-broadcast into the target channel under the given `topic`. Topic is
 * the same string the source strategy emits as its routing key
 * (e.g. "ai_news.tech", "motivation.quote.morning"). Uniqueness is per
 * (source, topic) so the same source can route the same topic into only
 * one target — change targets by deleting + re-adding.
 */
@Controller('api/forward-routes')
@UseGuards(TrackingAuthGuard)
export class ForwardRoutesController {
  constructor(
    private readonly repo:      ForwardRoutesRepository,
    private readonly cache:     ConfigCacheService,
    private readonly publisher: ConfigEventsPublisher,
  ) {}

  /**
   * List all routes — optionally filtered by source. UI typically queries
   * `?source=<channelId>` from the channel-detail page.
   */
  @Get()
  async list(@Query('source') sourceId?: string) {
    const rows = sourceId
      ? await this.repo.listBySource(sourceId)
      : await this.repo.list();
    return rows.map(r => ({
      id:                r.id,
      source_channel_id: r.source_channel_id,
      target_channel_id: r.target_channel_id,
      topic:             r.topic,
      description:       r.description,
      source_channel_key: this.cache.getChannelById(r.source_channel_id)?.channel_key ?? null,
      target_channel_key: this.cache.getChannelById(r.target_channel_id)?.channel_key ?? null,
      target_title:       this.cache.getChannelById(r.target_channel_id)?.title ?? null,
    }));
  }

  @Post()
  async create(@Body() body: CreateForwardRouteDto) {
    if (body.source_channel_id === body.target_channel_id) {
      throw new BadRequestException('source and target must be different channels');
    }
    if (!this.cache.getChannelById(body.source_channel_id)) {
      throw new BadRequestException(`source_channel_id ${body.source_channel_id} not found`);
    }
    if (!this.cache.getChannelById(body.target_channel_id)) {
      throw new BadRequestException(`target_channel_id ${body.target_channel_id} not found`);
    }

    // Topic uniqueness per source — we relay this as a 409 rather than
    // letting it become an opaque pg unique-violation 500.
    const existing = await this.repo.listBySource(body.source_channel_id);
    if (existing.some(r => r.topic === body.topic)) {
      throw new ConflictException(`topic "${body.topic}" already routed from this source`);
    }

    const row = await this.repo.insert({
      source_channel_id: body.source_channel_id,
      target_channel_id: body.target_channel_id,
      topic:             body.topic,
      description:       body.description ?? '',
    });
    await this.publisher.publish('forward-route', row.id);
    return row;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', new ParseUUIDPipe()) id: string) {
    const ok = await this.repo.delete(id);
    if (!ok) throw new NotFoundException(`Forward route ${id} not found`);
    await this.publisher.publish('forward-route', id);
  }
}
