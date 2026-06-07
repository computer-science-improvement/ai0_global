import { Injectable } from '@nestjs/common';
import { PostPayload } from '../common/types';
import { BasePublisher, PublishTarget } from './base.publisher';
import { FacebookPublisher } from './facebook.publisher';
import { InstagramPublisher } from './instagram.publisher';
import { ThreadsPublisher } from './threads.publisher';
import type { MetaPlatform } from '../config/meta-accounts.repository';

/** Routes a publish to the right Meta platform publisher. Telegram has its own
 *  dedicated path (TelegramPublisher) and is not handled here. */
@Injectable()
export class PublisherDispatcher {
  private readonly byPlatform: Record<MetaPlatform, BasePublisher>;

  constructor(fb: FacebookPublisher, ig: InstagramPublisher, th: ThreadsPublisher) {
    this.byPlatform = { facebook: fb, instagram: ig, threads: th };
  }

  publish(platform: MetaPlatform, payload: PostPayload, target: PublishTarget): Promise<string> {
    const publisher = this.byPlatform[platform];
    if (!publisher) throw new Error(`No publisher for platform ${platform}`);
    return publisher.publish(payload, target);
  }
}
