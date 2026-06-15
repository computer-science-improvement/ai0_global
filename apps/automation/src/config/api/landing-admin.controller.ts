// apps/automation/src/config/api/landing-admin.controller.ts
// OPERATOR-FACING admin surface for the landing page. Class-level guard (same as
// the other config controllers; no global APP_GUARD). Lists ALL candidates across
// the 3 tables and toggles each one's landing_visible / landing_order.
// The PUBLIC LandingController stays separate and unguarded.
import {
  BadRequestException, Body, Controller, Get, Param, Patch, UseGuards,
} from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import {
  LandingAdminResource, LandingPlatform, LandingResourcesService,
} from '../landing-resources.service';
import { PatchLandingDto } from './dto/landing.dto';

const PLATFORMS: readonly LandingPlatform[] = ['telegram', 'instagram', 'facebook', 'threads', 'tiktok'];

@Controller('api/landing/admin')
@UseGuards(TrackingAuthGuard)
export class LandingAdminController {
  constructor(private readonly landing: LandingResourcesService) {}

  @Get()
  list(): Promise<LandingAdminResource[]> {
    return this.landing.listAdmin();
  }

  @Patch(':platform/:id')
  async patch(
    @Param('platform') platform: string,
    @Param('id') id: string,
    @Body() dto: PatchLandingDto,
  ): Promise<{ ok: true }> {
    if (!PLATFORMS.includes(platform as LandingPlatform)) {
      throw new BadRequestException(`Unknown landing platform: ${platform}`);
    }
    await this.landing.setFeatured(platform as LandingPlatform, id, {
      visible: dto.landingVisible,
      order: dto.landingOrder,
    });
    return { ok: true };
  }
}
