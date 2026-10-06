import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { DataController } from './data.controller';

/** Spec 032: the unified data store API (/api/data). DataStore itself is a plain class over the pool. */
@Module({
  imports: [AuthModule],
  controllers: [DataController],
  providers: [TrackingAuthGuard],
})
export class DataModule {}
