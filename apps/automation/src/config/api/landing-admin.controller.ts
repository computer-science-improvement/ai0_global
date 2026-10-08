// apps/automation/src/config/api/landing-admin.controller.ts
// OPERATOR-FACING admin surface for the landing page. Class-level guard (same as
// the other config controllers; no global APP_GUARD). Lists ALL candidates across
// the 3 tables and toggles each one's landing_visible / landing_order, and edits the
// "Public page" settings (spec 026 FR-002/FR-015: DM username, template, white label).
// The PUBLIC LandingController stays separate and unguarded.
import {
  BadRequestException, Body, Controller, Get, HttpCode, Inject, NotFoundException, Optional, Param, Patch, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import {
  LANDING_PLATFORMS, LandingAdminResource, LandingPlatform, LandingResourcesService,
} from '../landing-resources.service';
import type { LandingAdminConfig, LandingConfigService, LandingDmPreview } from '../landing-config.service';
import { PatchLandingDto } from './dto/landing.dto';
import {
  networkPatchIssues, type LandingAdminNetwork, type LandingNetwork, type LandingNetworksService,
} from '../landing-networks.service';
import { LANDING_CONFIG, LANDING_CTA, LANDING_LEADS, LANDING_NETWORKS } from './landing.controller';
import type { LandingLeadRow, LandingLeadsService } from '../landing-leads.service';
import type { CtaStats, LandingCtaService } from '../landing-cta.service';

const PLATFORMS: readonly LandingPlatform[] = LANDING_PLATFORMS;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    @Optional() @Inject(LANDING_NETWORKS) private readonly networks?: LandingNetworksService,
    @Optional() @Inject(LANDING_CTA) private readonly cta?: LandingCtaService,
    @Optional() @Inject(LANDING_LEADS) private readonly leads?: LandingLeadsService,
  ) {}

  /** Spec 026 FR-015: leads from the public forms; `?kind=ad|white_label&status=…` (spam only when asked for). */
  @Get('leads')
  listLeads(@Query('kind') kind?: string, @Query('status') status?: string, @Query('limit') limit?: string): Promise<LandingLeadRow[]> {
    if (!this.leads) throw new NotFoundException('leads are not available');
    return this.leads.list({ kind, status, limit });
  }

  /** `{status?, ownerNote?}`; 400 `invalid_lead_patch`, 404 for an unknown lead. Declared before `:platform/:id`. */
  @Patch('leads/:id')
  async patchLead(@Param('id') id: string, @Body() body: Record<string, unknown>): Promise<LandingLeadRow> {
    if (!this.leads) throw new NotFoundException('leads are not available');
    const row = await this.leads.patch(id, body);
    if (!row) throw new NotFoundException('unknown lead');
    return row;
  }

  /** Spec 026 FR-015: CTA clicks per placement over `days` (default 30) against landing-tagged DM threads and leads. */
  @Get('cta-stats')
  ctaStats(@Query('days') days?: string): Promise<CtaStats> {
    if (!this.cta) throw new NotFoundException('CTA stats are not available');
    return this.cta.stats(days ?? 30);
  }

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

  /** Spec 026 FR-015: every network with its blurb and order, plus the exact public payload as a preview. */
  @Get('networks')
  networksAdmin(): Promise<{ networks: LandingAdminNetwork[]; preview: LandingNetwork[] }> {
    if (!this.networks) throw new NotFoundException('networks are not available');
    return this.networks.admin();
  }

  /** `{blurb?: string | null, order?: number}`; 400 `invalid_network_patch` with issues, 404 for an unknown network.
   *  Declared before `:platform/:id` so `network/<id>` is not read as a platform. */
  @Patch('network/:groupId')
  async patchNetwork(@Param('groupId') groupId: string, @Body() body: Record<string, unknown>): Promise<{ ok: true }> {
    if (!this.networks) throw new NotFoundException('networks are not available');
    if (!UUID_RE.test(groupId)) throw new NotFoundException('unknown network');
    const b = body && typeof body === 'object' ? body : {};
    const issues = networkPatchIssues({ blurb: b.blurb, order: b.order });
    if (issues.length) throw new BadRequestException({ error: 'invalid_network_patch', issues });
    const found = await this.networks.patchNetwork(groupId, {
      blurb: b.blurb as string | null | undefined,
      order: b.order as number | undefined,
    });
    if (!found) throw new NotFoundException('unknown network');
    return { ok: true };
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
    this.networks?.invalidate();
    return { ok: true };
  }
}
