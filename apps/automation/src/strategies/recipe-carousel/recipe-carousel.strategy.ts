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
import { TelegramPublisher } from '../../publishers/telegram.publisher';
import type { PublishDestination, DestinationPlatform } from '../../common/content-strategy/publish-destination';
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
  ) {}

  onModuleInit() { this.registry.register(this); }

  getSkills(_params: StrategyParams): Skill[] { return []; }
  async fetch(_params: StrategyParams, _channelId: string): Promise<StrategyFetchResult | null> { return null; }
  async generate(_data: StrategyFetchResult, _params: StrategyParams): Promise<StrategyPost | 'SKIP_POST' | null> { return null; }

  async execute(_channelId: string, _params: StrategyParams, dest?: PublishDestination): Promise<void> {
    if (!dest) {
      this.logger.warn('recipe-carousel: no destination');
      return;
    }

    if (dest.platform === 'telegram') {
      await this.executeTelegramSource(dest);
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

    const row = await this.repo.getNextForCarousel(dest.postedKey);
    if (!row) { this.logger.debug('No carousel-eligible recipes'); return; }

    const recipe  = toCarouselRecipe(row);
    const caption = buildCarouselCaption(row);

    const imageBuffer = await this.images.download(row.image_url);
    if (!imageBuffer) throw new Error(`Carousel image download failed (${row.id})`);

    const slides = await this.renderer.render(recipe, imageBuffer);
    const keyPrefix = `carousel/${dest.platform}/${dest.metaAccountId}/${row.id}`;
    const hosted = await this.hosting.upload(slides, keyPrefix);

    try {
      const id = await this.dispatcher.publishCarousel(
        dest.platform as MetaPlatform,
        { text: caption, tags: row.category ? [row.category] : [], source: '' },
        hosted.map(h => h.url),
        { id: dest.targetId, token: dest.token },
      );
      await this.repo.markPosted(row.id, dest.postedKey);
      this.logger.debug(`Published carousel ${row.id} → ${dest.platform} (${id})`);

      await this.groupFanOut.fanOut(
        dest,
        { caption, tags: row.category ? [row.category] : [], imageUrls: hosted.map(h => h.url), carousel: true },
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
  private async executeTelegramSource(dest: PublishDestination): Promise<void> {
    const row = await this.repo.getNextForCarousel(dest.postedKey); // postedKey === 'TELEGRAM'
    if (!row) { this.logger.debug('No carousel-eligible recipes'); return; }

    const recipe  = toCarouselRecipe(row);
    const caption = buildCarouselCaption(row);
    const imageBuffer = await this.images.download(row.image_url);
    if (!imageBuffer) throw new Error(`Carousel image download failed (${row.id})`);

    const slides = await this.renderer.render(recipe, imageBuffer);
    const hosted = await this.hosting.upload(slides, `carousel/telegram/${dest.targetId}/${row.id}`);

    try {
      const mid = await this.telegramPub.publish(
        { text: caption, imageUrl: hosted[0].url, source: '', tags: row.category ? [row.category] : [] },
        { id: dest.targetId, token: '' },
      );
      await this.repo.markPosted(row.id, dest.postedKey);
      this.logger.debug(`Published carousel cover ${row.id} → telegram (${mid})`);

      await this.groupFanOut.fanOut(
        dest,
        { caption, tags: row.category ? [row.category] : [], imageUrls: hosted.map(h => h.url), carousel: true },
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
