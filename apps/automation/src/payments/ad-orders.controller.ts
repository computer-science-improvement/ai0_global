import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Optional, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { AdOrdersRepository } from './ad-orders.repository';
import { AdOrdersService, digestSponsorNotSold } from './ad-orders.service';
import { SponsorOrdersRepository } from './sponsor-orders.repository';
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
  constructor(private readonly prices: AdPricesRepository, @Optional() private readonly sponsors?: SponsorOrdersRepository) {}

  /** Rows carry `sellable` (spec 036): a digest_sponsor price is not offered where no digest strategy runs. */
  @Get() list(@Query('active') active?: string) { return this.prices.list({ activeOnly: active === 'true' }); }

  /** Spec 036: a digest_sponsor price is refused on a channel without a running digest strategy (it could not be fulfilled). */
  @Put() async upsert(@Body() dto: UpsertPriceDto) {
    const channelKey = withAt(dto.channelKey);
    if (dto.format === 'digest_sponsor' && this.sponsors && !(await this.sponsors.digestRunsOn(channelKey))) {
      throw new BadRequestException(digestSponsorNotSold(channelKey));
    }
    return this.prices.upsertActive({ channelKey, format: dto.format, priceUah: dto.priceUah, note: dto.note ?? null });
  }

  @Delete(':id') async deactivate(@Param('id') id: string) {
    if (!(await this.prices.deactivate(id))) throw new NotFoundException('price not found or already inactive');
    return { ok: true };
  }
}
