// PUBLIC endpoints: no `@UseGuards` (guards are per-controller in this app).
// They expose only public projections — prices without ids, channel stats,
// and a report addressed by an unguessable token. Never order rows, amounts
// or advertiser contacts.
import { Controller, Get, Inject, NotFoundException, Optional, Param } from '@nestjs/common';
import { AdPricesRepository, MediaKitChannel, toPublicPrice } from './ad-prices.repository';
import { LANDING_CONFIG } from '../config/api/landing.controller';
import type { LandingConfigService } from '../config/landing-config.service';
import { buildAdDmUrl } from '../config/landing-dm';
import { AdOrdersRepository } from './ad-orders.repository';
import type { AdReport, PublicAdPrice } from './ad-orders.types';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

@Controller('api')
export class AdsPublicController {
  constructor(
    private readonly prices: AdPricesRepository,
    private readonly orders: AdOrdersRepository,
    @Optional() @Inject(LANDING_CONFIG) private readonly landing?: Pick<LandingConfigService, 'adDm'>,
  ) {}

  /** T001: the active price list. */
  @Get('landing/prices')
  async listPrices(): Promise<PublicAdPrice[]> {
    return (await this.prices.list({ activeOnly: true })).map(toPublicPrice);
  }

  /**
   * T008: channels with active prices, live stats and their prices. Spec 026 FR-009:
   * each row also carries `adDmUrl`, the "Order an ad in Telegram" link with this
   * channel as the target (placement `mediakit`), or null when no DM account resolves.
   */
  @Get('landing/media-kit')
  async mediaKit(): Promise<Array<MediaKitChannel & { adDmUrl: string | null }>> {
    const [rows, dm] = await Promise.all([
      this.prices.mediaKit(),
      this.landing ? this.landing.adDm().catch(() => null) : Promise.resolve(null),
    ]);
    return rows.map((c) => ({
      ...c,
      adDmUrl: dm
        ? buildAdDmUrl({ username: dm.username, template: dm.template, placement: 'mediakit', target: c.title ?? c.channelKey, channelKey: c.channelKey })
        : null,
    }));
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
