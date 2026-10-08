// apps/automation/src/config/api/landing-admin.controller.ts
// OPERATOR-FACING admin surface for the landing page. Class-level guard (same as
// the other config controllers; no global APP_GUARD). Lists ALL candidates across
// the 3 tables and toggles each one's landing_visible / landing_order, and edits the
// "Public page" settings (spec 026 FR-002/FR-015: DM username, template, white label).
// The PUBLIC LandingController stays separate and unguarded.
import {
  BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, UseGuards,
} from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import {
  LandingAdminResource, LandingPlatform, LandingResourcesService,
} from '../landing-resources.service';
import type { LandingAdminConfig, LandingConfigService, LandingDmPreview } from '../landing-config.service';
import { PatchLandingDto } from './dto/landing.dto';
import { LANDING_CONFIG } from './landing.controller';

const PLATFORMS: readonly LandingPlatform[] = ['telegram', 'instagram', 'facebook', 'threads', 'tiktok'];

function stringOrNull(v: unknown, field: string): string | null | undefined {
  if (v === undefined || v === null || typeof v === 'string') return v as string | null | undefined;
  throw new BadRequestException({ error: 'invalid_landing_config', issues: [{ path: field, message: 'must be a string or null' }] });
}

@Controller('api/landing/admin')
@UseGuards(TrackingAuthGuard)
export class LandingAdminController {
  constructor(
    private readonly landing: LandingResourcesService,
    @Inject(LANDING_CONFIG) private readonly config: LandingConfigService,
  ) {}

  @Get()
  list(): Promise<LandingAdminResource[]> {
    return this.landing.listAdmin();
  }

  /** The stored settings, the defaults and the username the public CTAs resolve to now. */
  @Get('config')
  getConfig(): Promise<LandingAdminConfig> {
    return this.config.adminConfig();
  }

  /** `{adTgUsername?, adMessage?, whiteLabelEnabled?}`; null or '' resets a key. 400 `invalid_landing_config` with issues. */
  @Put('config')
  putConfig(@Body() body: Record<string, unknown>): Promise<LandingAdminConfig> {
    const b = body && typeof body === 'object' ? body : {};
    return this.config.update({
      adTgUsername:      stringOrNull(b.adTgUsername, 'adTgUsername'),
      adMessage:         stringOrNull(b.adMessage, 'adMessage'),
      whiteLabelEnabled: b.whiteLabelEnabled as boolean | undefined,
    });
  }

  /** Live preview of a draft (nothing is saved): the messages and links the public page would use. */
  @Post('config/preview')
  @HttpCode(200)
  preview(@Body() body: Record<string, unknown>): Promise<LandingDmPreview> {
    const b = body && typeof body === 'object' ? body : {};
    return this.config.preview({ adTgUsername: b.adTgUsername, adMessage: b.adMessage });
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
