import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { LiqpayService } from './liqpay.service';
import { AdOrdersRepository } from './ad-orders.repository';

const PAID_STATUSES = new Set(['success', 'sandbox', 'wait_accept']);

@Controller('api/payments/liqpay')
export class LiqpayCallbackController {
  constructor(private readonly liqpay: LiqpayService, private readonly repo: AdOrdersRepository) {}

  // Public endpoint — authenticated by LiqPay signature, NOT by the auth guard.
  @Post('callback')
  async callback(@Body() body: { data?: string; signature?: string }) {
    const res = this.liqpay.verifyCallback(body?.data ?? '', body?.signature ?? '');
    if (!res.valid) throw new BadRequestException('invalid signature');
    if (res.orderId && res.status && PAID_STATUSES.has(res.status)) {
      await this.repo.markPaid(res.orderId);
    }
    return { ok: true };
  }
}
