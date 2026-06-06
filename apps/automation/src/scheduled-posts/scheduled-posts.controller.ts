import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ScheduledPostsService } from './scheduled-posts.service';
import { ComposedPostDto } from './dto/composed-post.dto';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import type { ComposedPost } from './scheduled-posts.types';

@Controller('scheduled-posts')
@UseGuards(TrackingAuthGuard)
export class ScheduledPostsController {
  constructor(private readonly service: ScheduledPostsService) {}

  @Post()                create(@Body() dto: ComposedPostDto)            { return this.service.create(dto as ComposedPost); }
  @Get()                 list(@Query('status') status?: string)         { return this.service.list(status); }
  @Get(':id')            one(@Param('id', new ParseUUIDPipe()) id: string) { return this.service.get(id); }
  @Patch(':id')          update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ComposedPostDto) { return this.service.update(id, dto as ComposedPost); }
  @Post(':id/cancel')    cancel(@Param('id', new ParseUUIDPipe()) id: string) { return this.service.cancel(id); }
}
