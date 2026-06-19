import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ContentStrategyRegistry } from '../../common/content-strategy/content-strategy.registry';
import { RecipeCarouselRendererService } from '../../common/carousel/recipe-carousel-renderer.service';
import { SlideHostingService } from '../../publishers/hosting/slide-hosting.service';
import { PublisherDispatcher } from '../../publishers/publisher-dispatcher.service';
import { ImageResolverService } from '../../common/processors/image-resolver.service';
import { isPermanentMetaMediaError } from '../../publishers/meta-graph.util';
import { RecipesRepository } from '../recipes/recipes.repository';
import { TikTokCarouselPublisher } from '../../publishers/tiktok/tiktok-carousel.publisher';
import { toCarouselRecipe, buildCarouselCaption } from './recipe-carousel.map';
import { GroupFanOutService } from '../../common/content-strategy/group-fanout.service';
import { DestinationResolver } from '../../common/content-strategy/destination-resolver.service';
import { RunTracer } from '../../common/observability/run-tracer.service';
import { buildRecipeCaptionParts, renderParts, type MetaCaptionOverrides } from './recipe-caption-parts';
import { TelegramPublisher } from '../../publishers/telegram.publisher';
import type { PublishDestination, DestinationPlatform } from '../../common/content-strategy/publish-destination';
import type { RecipeRow } from '../recipes/recipes.repository';
import type { MetaPlatform } from '../../config/meta-accounts.repository';
import {
  ContentStrategy, StrategyFetchResult, StrategyPost, StrategyParams,
} from '../../common/content-strategy/content-strategy.interface';
import { Skill } from '../../common/ai/skills/skill.interface';

/**
 * recipe-carousel — Meta, TikTok, and Telegram-source. Renders a recipe into
 * 3 slides, hosts them, publishes an IG/Threads carousel, FB album, TikTok
 * photo carousel (9:16), or a Telegram cover + group fan-out, records
 * per-destination dedup, and deletes the hosted slides.
 */
@Injectable()
export class RecipeCarouselStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(RecipeCarouselStrategy.name);
  readonly type = 'recipe-carousel';
  readonly supportedPlatforms: DestinationPlatform[] = ['telegram', 'instagram', 'facebook', 'threads', 'tiktok'];

  constructor(
    private readonly repo:         RecipesRepository,
    private readonly renderer:     RecipeCarouselRendererService,
    private readonly hosting:      SlideHostingService,
    private readonly dispatcher:   PublisherDispatcher,
    private readonly images:       ImageResolverService,
    private readonly registry:     ContentStrategyRegistry,
    private readonly tiktok:       TikTokCarouselPublisher,
    private readonly groupFanOut:  GroupFanOutService,
    private readonly telegramPub:  TelegramPublisher,
    private readonly destinations: DestinationResolver,
    private readonly tracer:       RunTracer,
  ) {}

  onModuleInit() { this.registry.register(this); }

  /**
   * Per-platform caption built from the shared recipe caption PARTS, so the
   * output is identical to the dashboard Post-Preview. Recipe parts (title /
   * category / macros) are fixed; cta / hashtags / intro / outro / tg-link
   * label come from the binding's `params.metaCaption` overrides (defaults
   * reproduce the prior output). The Telegram-channel link is resolved from the
   * dest's group and rendered on Facebook & Threads only.
   */
  private async buildCaptionFor(
    dest: PublishDestination, row: RecipeRow, params?: StrategyParams,
  ): Promise<(platform: DestinationPlatform) => string> {
    const telegramLink = await this.destinations.resolveGroupTelegramLink(dest);
    const overrides = (params?.metaCaption ?? undefined) as MetaCaptionOverrides | undefined;
    const parts = buildRecipeCaptionParts(row, { overrides, telegramLink });
    return (platform) => renderParts(parts, platform);
  }

  getSkills(_params: StrategyParams): Skill[] { return []; }
  async fetch(_params: StrategyParams, _channelId: string): Promise<StrategyFetchResult | null> { return null; }
  async generate(_data: StrategyFetchResult, _params: StrategyParams): Promise<StrategyPost | 'SKIP_POST' | null> { return null; }

  async execute(_channelId: string, params: StrategyParams, dest?: PublishDestination): Promise<void> {
    if (!dest) {
      this.logger.warn('recipe-carousel: no destination');
      return;
    }

    if (dest.platform === 'telegram') {
      await this.executeTelegramSource(dest, params);
      return;
    }

    if (dest.platform === 'tiktok') {
      const row = await this.repo.getNextForCarousel(dest.postedKey);
      if (!row) { this.logger.debug('No carousel-eligible recipes'); return; }
      const recipe = toCarouselRecipe(row);
      const caption = buildCarouselCaption(row);
      const imageBuffer = await this.images.download(row.image_url);
      if (!imageBuffer) throw new Error(`Carousel image download failed (${row.id})`);
      const slides = await this.renderer.render(recipe, imageBuffer, { width: 1080, height: 1920 });
      const hosted = await this.hosting.upload(slides, `carousel/tiktok/${dest.targetId}/${row.id}`);
      try {
        const id = await this.tiktok.publishCarousel(dest.targetId, hosted.map(h => h.url), caption);
        await this.repo.markPosted(row.id, dest.postedKey);
        this.logger.debug(`Published carousel ${row.id} → tiktok (${id})`);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        this.logger.error(`TikTok carousel failed (${row.id}): ${msg}`);
        throw new Error(`Carousel publish (tiktok): ${msg}`);
      } finally {
        await this.hosting.delete(hosted.map(h => h.path));
      }
      return;
    }

    if (!dest.token) {
      this.logger.error(`Carousel skipped: token missing for ${dest.platform}`);
      return;
    }

    const row = await this.tracer.span('Recipes', 'select', () => this.repo.getNextForCarousel(dest.postedKey));
    if (!row) { this.logger.debug('No carousel-eligible recipes'); return; }

    const recipe  = toCarouselRecipe(row);

    const imageBuffer = await this.tracer.span('Image', 'download', () => this.images.download(row.image_url));
    if (!imageBuffer) throw new Error(`Carousel image download failed (${row.id})`);

    const slides = await this.tracer.span('Renderer', 'render', () => this.renderer.render(recipe, imageBuffer));
    const keyPrefix = `carousel/${dest.platform}/${dest.metaAccountId}/${row.id}`;
    const hosted = await this.tracer.span('Hosting', 'upload', () => this.hosting.upload(slides, keyPrefix));

    const captionFor = await this.buildCaptionFor(dest, row, params);

    try {
      const id = await this.tracer.span(dest.platform, 'publishCarousel', () => this.dispatcher.publishCarousel(
        dest.platform as MetaPlatform,
        { text: captionFor(dest.platform), tags: row.category ? [row.category] : [], source: '' },
        hosted.map(h => h.url),
        { id: dest.targetId, token: dest.token! },
      ));
      await this.repo.markPosted(row.id, dest.postedKey);
      this.logger.debug(`Published carousel ${row.id} → ${dest.platform} (${id})`);

      await this.groupFanOut.fanOut(
        dest,
        { caption: captionFor('telegram'), captionFor, tags: row.category ? [row.category] : [], imageUrls: hosted.map(h => h.url), carousel: true },
        (key) => this.repo.markPosted(row.id, key),
      );
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      this.logger.error(`Carousel publish failed (${row.id} → ${dest.platform}): ${msg}`);
      // Permanent media errors never succeed for this image — advance the queue.
      if (isPermanentMetaMediaError(msg)) {
        try { await this.repo.markPosted(row.id, dest.postedKey); } catch { /* best-effort */ }
      }
      throw new Error(`Carousel publish (${dest.platform}): ${msg}`);
    } finally {
      // Slides are ingested by Meta during container/photo creation; drop our copies.
      await this.hosting.delete(hosted.map(h => h.path));
    }
  }

  /** Telegram is this group's source: publish the recipe cover + caption to the
   *  Telegram channel, then fan the rendered carousel out to the group's Meta
   *  members. Slides stay hosted until fan-out completes. */
  private async executeTelegramSource(dest: PublishDestination, params?: StrategyParams): Promise<void> {
    const row = await this.tracer.span('Recipes', 'select', () => this.repo.getNextForCarousel(dest.postedKey)); // postedKey === 'TELEGRAM'
    if (!row) { this.logger.debug('No carousel-eligible recipes'); return; }

    const recipe  = toCarouselRecipe(row);
    const imageBuffer = await this.tracer.span('Image', 'download', () => this.images.download(row.image_url));
    if (!imageBuffer) throw new Error(`Carousel image download failed (${row.id})`);

    const slides = await this.tracer.span('Renderer', 'render', () => this.renderer.render(recipe, imageBuffer));
    const hosted = await this.tracer.span('Hosting', 'upload', () => this.hosting.upload(slides, `carousel/telegram/${dest.targetId}/${row.id}`));
    const captionFor = await this.buildCaptionFor(dest, row, params);

    try {
      const mid = await this.tracer.span('telegram', 'publish', () => this.telegramPub.publish(
        { text: captionFor('telegram'), imageUrl: hosted[0].url, source: '', tags: row.category ? [row.category] : [] },
        { id: dest.targetId, token: '' },
      ));
      await this.repo.markPosted(row.id, dest.postedKey);
      this.logger.debug(`Published carousel cover ${row.id} → telegram (${mid})`);

      await this.groupFanOut.fanOut(
        dest,
        { caption: captionFor('telegram'), captionFor, tags: row.category ? [row.category] : [], imageUrls: hosted.map(h => h.url), carousel: true },
        (key) => this.repo.markPosted(row.id, key),
      );
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      this.logger.error(`Carousel telegram publish failed (${row.id}): ${msg}`);
      throw new Error(`Carousel publish (telegram): ${msg}`);
    } finally {
      await this.hosting.delete(hosted.map(h => h.path));
    }
  }
}
