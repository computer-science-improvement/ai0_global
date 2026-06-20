import { Module } from '@nestjs/common';
import { RetentionService } from './retention.service';

// DB_POOL comes from the @Global DatabaseModule; ConfigModule is global too, so
// this module only needs to declare the service.
@Module({
  providers: [RetentionService],
  exports:   [RetentionService],
})
export class RetentionModule {}
