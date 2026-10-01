import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LiqpayService } from './liqpay.service';
import { AdOrdersRepository } from './ad-orders.repository';

/**
 * Only `success` means money landed. `wait_accept` (merchant not yet
 * verified — funds held) is NOT paid. `sandbox` is a test payment and counts
 * only when LIQPAY_SANDBOX=true, so a sandbox callback can never flip a real
 * order to paid in production.
 */
export function paidStatuses(config: ConfigService): Set<string> {
  const s = new Set(['success']);
  if (config.get<string>('LIQPAY_SANDBOX') === 'true') s.add('sandbox');
  return s;
}

@Controller('api/payments/liqpay')
export class LiqpayCallbackController {
  constructor(
    private readonly liqpay: LiqpayService,
    private readonly repo:   AdOrdersRepository,
    private readonly config: ConfigService,
  ) {}

  // Public endpoint — authenticated by LiqPay signature, NOT by the auth guard.
  @Post('callback')
  async callback(@Body() body: { data?: string; signature?: string }) {
    const res = this.liqpay.verifyCallback(body?.data ?? '', body?.signature ?? '');
    if (!res.valid) throw new BadRequestException('invalid signature');
    if (res.orderId && res.status && paidStatuses(this.config).has(res.status)) {
      await this.repo.markPaid(res.orderId);
    }
    return { ok: true };
  }
}
