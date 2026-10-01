// PUBLIC endpoints: no `@UseGuards` (guards are per-controller in this app).
// They expose only public projections — prices without ids, channel stats,
// and a report addressed by an unguessable token. Never order rows, amounts
// or advertiser contacts.
import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { AdPricesRepository, MediaKitChannel, toPublicPrice } from './ad-prices.repository';
import { AdOrdersRepository } from './ad-orders.repository';
import type { AdReport, PublicAdPrice } from './ad-orders.types';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

@Controller('api')
export class AdsPublicController {
  constructor(private readonly prices: AdPricesRepository, private readonly orders: AdOrdersRepository) {}

  /** T001: the active price list. */
  @Get('landing/prices')
  async listPrices(): Promise<PublicAdPrice[]> {
    return (await this.prices.list({ activeOnly: true })).map(toPublicPrice);
  }

  /** T008: channels with active prices, live stats and their prices. */
  @Get('landing/media-kit')
  mediaKit(): Promise<MediaKitChannel[]> {
    return this.prices.mediaKit();
  }

  /** T005: the advertiser report behind a public token. */
  @Get('ads/report/:token')
  async report(@Param('token') token: string): Promise<AdReport> {
    if (!TOKEN_RE.test(token)) throw new NotFoundException('report not found');
    const r = await this.orders.reportByToken(token);
    if (!r) throw new NotFoundException('report not found');
    return r;
  }
}
