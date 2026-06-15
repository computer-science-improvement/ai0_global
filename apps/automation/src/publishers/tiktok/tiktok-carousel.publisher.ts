// Publishes hosted slide URLs as a TikTok photo carousel (DIRECT_POST): resolve a
// valid access token (5a), init the post, then poll its status to completion.
// The `sleep` seam is overridable in tests so polling needs no real delay.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TikTokTokenService } from '../../config/tiktok-token.service';
import { TikTokContentClient } from './tiktok-content.client';
import {
  buildPhotoPostBody, captionToTitleDescription, isComplete, isFailed, TikTokPrivacy,
} from './tiktok-content.util';

const MAX_POLLS = 10;
const POLL_INTERVAL_MS = 3000;

@Injectable()
export class TikTokCarouselPublisher {
  private readonly logger = new Logger(TikTokCarouselPublisher.name);

  constructor(
    private readonly tokenService: TikTokTokenService,
    private readonly client:       TikTokContentClient,
    private readonly config:       ConfigService,
  ) {}

  /** Delay seam — overridable in tests. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Publish image URLs as a TikTok photo carousel for `accountId`. Returns the publish_id. */
  async publishCarousel(accountId: string, imageUrls: string[], caption: string): Promise<string> {
    const token = await this.tokenService.getValidAccessToken(accountId);
    const { title, description } = captionToTitleDescription(caption);
    const privacyLevel = (this.config.get<string>('TIKTOK_PRIVACY_LEVEL') ?? 'SELF_ONLY') as TikTokPrivacy;

    const body = buildPhotoPostBody({ imageUrls, title, description, privacyLevel });
    const { publishId } = await this.client.initPhotoPost(token, body);

    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      const { status, failReason } = await this.client.fetchStatus(token, publishId);
      if (isComplete(status)) {
        this.logger.debug(`TikTok carousel published (${publishId})`);
        return publishId;
      }
      if (isFailed(status)) {
        throw new Error(`TikTok publish failed (${publishId}): ${failReason ?? 'unknown'}`);
      }
      await this.sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`TikTok publish timed out (${publishId})`);
  }
}
