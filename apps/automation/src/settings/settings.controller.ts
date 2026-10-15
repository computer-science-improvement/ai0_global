import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { IsDefined } from 'class-validator';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto } from './update-settings.dto';

/** PUT /settings/values/:key body: the value as a string, number or boolean (the catalog validates it). */
export class SetSettingDto {
  @IsDefined()
  value!: string | number | boolean;
}

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

  // ── Spec 039: the Configuration tab ─────────────────────────────────────────
  @Get('catalog')
  catalog() {
    return this.settings.catalog();
  }

  @Put('values/:key')
  setValue(@Param('key') key: string, @Body() dto: SetSettingDto) {
    return this.settings.setValue(key, dto.value);
  }

  @Delete('values/:key')
  reset(@Param('key') key: string) {
    return this.settings.reset(key);
  }

  @Post('values/:key/import-env')
  @HttpCode(200)
  importEnv(@Param('key') key: string) {
    return this.settings.importEnv(key);
  }

  @Post('restart')
  @HttpCode(202)
  restart() {
    return this.settings.restart();
  }
}
