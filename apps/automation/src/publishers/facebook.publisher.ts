import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostPayload } from '../common/types';
import { BasePublisher, PublishTarget } from './base.publisher';

// Docs: https://developers.facebook.com/docs/pages-api/posts

@Injectable()
export class FacebookPublisher extends BasePublisher {
  readonly platform = 'facebook';

  constructor(private readonly config: ConfigService) {
    super();
  }

  async publish(payload: PostPayload, target: PublishTarget): Promise<string> {
    const accessToken = this.config.getOrThrow<string>('FACEBOOK_ACCESS_TOKEN');
    // TODO: implement Meta Graph API page post
    // POST /{page-id}/photos or /{page-id}/feed
    throw new Error(`FacebookPublisher not yet implemented for ${target.id}`);
  }
}
