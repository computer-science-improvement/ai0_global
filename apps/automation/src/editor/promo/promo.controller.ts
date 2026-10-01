import { Controller, Get, Inject, NotFoundException, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { PromoService } from './promo.service';

export const PROMO_SERVICE = 'PROMO_SERVICE';

/** UTM redirect for tracked promo links (spec 022 FR-002) — public, logs a click and redirects. */
@Controller('r')
export class PromoRedirectController {
  constructor(@Inject(PROMO_SERVICE) private readonly svc: PromoService) {}

  @Get(':code')
  async go(@Param('code') code: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    if (!/^[a-f0-9]{6,20}$/.test(code)) throw new NotFoundException();
    const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.ip || null;
    const url = await this.svc.click(code, { userAgent: req.headers['user-agent'] ?? null, ip });
    if (!url) throw new NotFoundException();
    res.redirect(302, url);
  }
}

/** Promo pairs, recent promo slots and tracked links of an agent's network (spec 022 FR-007). */
@Controller('api')
@UseGuards(TrackingAuthGuard)
export class PromoController {
  constructor(@Inject(PROMO_SERVICE) private readonly svc: PromoService) {}

  @Get('agents/:handle/promo')
  promo(@Param('handle') handle: string) { return this.svc.overview(handle); }
}
