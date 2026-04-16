import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostPayload } from '../common/types';
import { BasePublisher, PublishTarget } from './base.publisher';

// Docs: https://developers.facebook.com/docs/instagram-api/guides/content-publishing

@Injectable()
export class InstagramPublisher extends BasePublisher {
  readonly platform = 'instagram';

  constructor(private readonly config: ConfigService) {
    super();
  }

  async publish(payload: PostPayload, target: PublishTarget): Promise<string> {
    const accessToken = this.config.getOrThrow<string>('INSTAGRAM_ACCESS_TOKEN');
    // TODO: implement Meta Graph API content publishing
    // Step 1: POST /{ig-user-id}/media → create container
    // Step 2: POST /{ig-user-id}/media_publish → publish container
    throw new Error(`InstagramPublisher not yet implemented for ${target.id}`);
  }
}
