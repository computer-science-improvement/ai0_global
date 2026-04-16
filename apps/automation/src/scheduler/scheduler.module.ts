import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';

// Стратегії реєструються через AppModule — SchedulerModule лише запускає планувальник
@Module({
  providers: [SchedulerService],
})
export class SchedulerModule {}
