import { Module } from '@nestjs/common';
import { AlertingService } from './alerting.service';

// StrategyRunsRepository (ChannelConfigModule) and TelegramNotifier
// (PublishersModule) are both exported from @Global modules; ConfigModule is
// global too — so this module only declares the watcher service.
@Module({
  providers: [AlertingService],
  exports:   [AlertingService],
})
export class AlertingModule {}
