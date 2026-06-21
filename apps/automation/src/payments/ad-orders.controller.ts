import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { AdOrdersRepository } from './ad-orders.repository';
import { AdOrdersService } from './ad-orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { ScheduleOrderDto } from './dto/schedule-order.dto';
import type { AdOrderStatus } from './ad-orders.types';

@Controller('api/ad-orders')
@UseGuards(TrackingAuthGuard)
export class AdOrdersController {
  constructor(private readonly repo: AdOrdersRepository, private readonly svc: AdOrdersService) {}

  @Get() list(@Query('status') status?: AdOrderStatus) { return this.repo.list(status); }
  @Post() create(@Body() dto: CreateOrderDto) {
    return this.repo.create({ advertiser: dto.advertiser, channelId: dto.channelId ?? null, amount: dto.amount, currency: dto.currency, description: dto.description ?? null });
  }
  @Post(':id/checkout') checkout(@Param('id') id: string) { return this.svc.createCheckout(id); }
  @Post(':id/schedule') schedule(@Param('id') id: string, @Body() dto: ScheduleOrderDto) { return this.svc.schedulePost(id, dto); }
}
