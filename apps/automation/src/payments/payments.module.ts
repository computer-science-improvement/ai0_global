import { Module } from '@nestjs/common';
import { LiqpayService } from './liqpay.service';
import { AdOrdersRepository } from './ad-orders.repository';
import { AdOrdersService } from './ad-orders.service';
import { AdOrdersController, AdPricesController } from './ad-orders.controller';
import { AdPricesRepository } from './ad-prices.repository';
import { AdReportsService } from './ad-reports.service';
import { AdsPublicController } from './ads-public.controller';
import { LiqpayCallbackController } from './liqpay-callback.controller';
import { AgentModule } from '../agent/agent.module';
import { AuthModule } from '../auth/auth.module';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';

// DB_POOL + ConfigService are global; AgentActionsRepository is provided by
// AgentModule (exported). AuthModule (exports AuthService) is required because
// AdOrdersController is guarded by TrackingAuthGuard, which injects AuthService.
@Module({
  imports:     [AgentModule, AuthModule],
  controllers: [AdOrdersController, AdPricesController, AdsPublicController, LiqpayCallbackController],
  providers:   [TrackingAuthGuard, LiqpayService, AdOrdersRepository, AdOrdersService, AdPricesRepository, AdReportsService],
})
export class PaymentsModule {}
