import { Module } from '@nestjs/common';
import { LiqpayService } from './liqpay.service';
import { AdOrdersRepository } from './ad-orders.repository';
import { AdOrdersService } from './ad-orders.service';
import { AdOrdersController } from './ad-orders.controller';
import { LiqpayCallbackController } from './liqpay-callback.controller';
import { AgentModule } from '../agent/agent.module';

// DB_POOL + ConfigService are global; AgentActionsRepository is provided by
// AgentModule. AgentActionsRepository is added to AgentModule.exports so
// AdOrdersService can inject it here.
@Module({
  imports:     [AgentModule],
  controllers: [AdOrdersController, LiqpayCallbackController],
  providers:   [LiqpayService, AdOrdersRepository, AdOrdersService],
})
export class PaymentsModule {}
