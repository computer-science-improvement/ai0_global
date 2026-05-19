// apps/automation/src/discovery/api/discovery.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { TeleAdsCategory, TeleAdsClient } from '../teleads/teleads.client';
import { ChannelThemesRepository } from '../repositories/channel-themes.repository';
import { RecommendationsService } from '../recommendations/recommendations.service';
import { RecommendRequestDto } from './dto/recommendations.dto';
import { UpdateThemesDto } from './dto/themes.dto';

const THEMES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

@Controller('api')
@UseGuards(TrackingAuthGuard)
export class DiscoveryController {
  private categoryCache: { at: number; data: TeleAdsCategory[] } | null = null;
  private validSlugs: Set<string> = new Set();

  constructor(
    private readonly teleads: TeleAdsClient,
    private readonly themes: ChannelThemesRepository,
    private readonly recs: RecommendationsService,
  ) {}

  @Get('themes')
  async themesList(): Promise<{ themes: { slug: string; title: string }[] }> {
    await this.ensureThemeCache();
    return {
      themes: this.categoryCache!.data.map(c => ({ slug: c.slug, title: c.title })),
    };
  }

  @Get('tracked-channels/:id/themes')
  async getChannelThemes(@Param('id') id: string): Promise<{ themes: string[] }> {
    const themes = await this.themes.getThemes(id);
    if (themes === null) throw new BadRequestException(`Channel ${id} not found`);
    return { themes };
  }

  @Put('tracked-channels/:id/themes')
  @HttpCode(204)
  async updateChannelThemes(
    @Param('id') id: string,
    @Body() body: UpdateThemesDto,
  ): Promise<void> {
    await this.ensureThemeCache();
    const invalid = body.themes.filter(t => !this.validSlugs.has(t));
    if (invalid.length) {
      throw new BadRequestException(`Unknown themes: ${invalid.join(', ')}`);
    }
    const ok = await this.themes.setThemes(id, body.themes);
    if (!ok) throw new BadRequestException(`Channel ${id} not found`);
  }

  @Post('recommendations')
  async recommendations(@Body() body: RecommendRequestDto) {
    return this.recs.recommend(body);
  }

  private async ensureThemeCache(): Promise<void> {
    if (this.categoryCache && Date.now() - this.categoryCache.at < THEMES_CACHE_TTL_MS) {
      return;
    }
    const data = await this.teleads.listCategories();
    this.categoryCache = { at: Date.now(), data };
    this.validSlugs = new Set(data.map(c => c.slug));
  }
}
