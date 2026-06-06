import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [SettingsController],
  providers: [SettingsService, TrackingAuthGuard],
})
export class SettingsModule {}
