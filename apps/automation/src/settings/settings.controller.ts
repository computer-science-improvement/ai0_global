import { Controller, Get, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { SettingsService } from './settings.service';

@Controller('settings')
@UseGuards(TrackingAuthGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  get() {
    return this.settings.get();
  }
}
