import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { TrackingModule } from '../tracking/tracking.module';

// TrackingModule exports REDIS_CLIENT, which SchedulerService now injects to
// subscribe to config:changed for hot-reload. ChannelConfigModule is already
// @Global so ChannelConfigService + StrategyRunsRepository resolve without
// being listed here.
@Module({
  imports:   [TrackingModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
