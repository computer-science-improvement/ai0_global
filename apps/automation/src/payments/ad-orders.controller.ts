import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { AdOrdersRepository } from './ad-orders.repository';
import { AdOrdersService } from './ad-orders.service';
import { AdPricesRepository } from './ad-prices.repository';
import { CreateOrderDto, UpdateOrderDto } from './dto/create-order.dto';
import { ScheduleOrderDto } from './dto/schedule-order.dto';
import { UpsertPriceDto } from './dto/price.dto';
import type { AdOrderStatus } from './ad-orders.types';

@Controller('api/ad-orders')
@UseGuards(TrackingAuthGuard)
export class AdOrdersController {
  constructor(private readonly repo: AdOrdersRepository, private readonly svc: AdOrdersService) {}

  @Get() list(@Query('status') status?: AdOrderStatus) { return this.repo.list(status); }
  @Post() create(@Body() dto: CreateOrderDto) { return this.svc.create(dto); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateOrderDto) { return this.svc.update(id, dto); }
  @Post(':id/checkout') checkout(@Param('id') id: string) { return this.svc.createCheckout(id); }
  @Post(':id/schedule') schedule(@Param('id') id: string, @Body() dto: ScheduleOrderDto) { return this.svc.schedulePost(id, dto); }
}

const withAt = (k: string) => (k.startsWith('@') ? k : `@${k}`);

/** Owner price list management (T001). History is kept: a new price deactivates the previous one. */
@Controller('api/ad-prices')
@UseGuards(TrackingAuthGuard)
export class AdPricesController {
  constructor(private readonly prices: AdPricesRepository) {}

  @Get() list(@Query('active') active?: string) { return this.prices.list({ activeOnly: active === 'true' }); }

  @Put() upsert(@Body() dto: UpsertPriceDto) {
    return this.prices.upsertActive({ channelKey: withAt(dto.channelKey), format: dto.format, priceUah: dto.priceUah, note: dto.note ?? null });
  }

  @Delete(':id') async deactivate(@Param('id') id: string) {
    if (!(await this.prices.deactivate(id))) throw new NotFoundException('price not found or already inactive');
    return { ok: true };
  }
}
