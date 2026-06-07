import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { ActivityController } from './activity.controller';
import { ActivityService } from './activity.service';
import { ActivityRepository } from './activity.repository';

@Module({
  imports: [AuthModule],
  controllers: [ActivityController],
  providers: [ActivityService, ActivityRepository, TrackingAuthGuard],
})
export class ActivityModule {}
