import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto } from './update-settings.dto';

@Controller('settings')
@UseGuards(TrackingAuthGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  get() {
    return this.settings.get();
  }

  @Patch()
  update(@Body() dto: UpdateSettingsDto) {
    return this.settings.update(dto);
  }
}
