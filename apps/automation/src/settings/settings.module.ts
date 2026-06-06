import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

// Global so any module (tracking scheduler, posting throttle, stats collector,
// MTProto client) can inject the shared SettingsService singleton and read
// live-overridable settings without import wiring.
@Global()
@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [SettingsController],
  providers: [SettingsService, TrackingAuthGuard],
  exports: [SettingsService],
})
export class SettingsModule {}
