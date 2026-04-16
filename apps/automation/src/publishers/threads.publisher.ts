import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostPayload } from '../common/types';
import { BasePublisher, PublishTarget } from './base.publisher';

// Docs: https://developers.facebook.com/docs/threads/posts

@Injectable()
export class ThreadsPublisher extends BasePublisher {
  readonly platform = 'threads';

  constructor(private readonly config: ConfigService) {
    super();
  }

  async publish(payload: PostPayload, target: PublishTarget): Promise<string> {
    const accessToken = this.config.getOrThrow<string>('THREADS_ACCESS_TOKEN');
    // TODO: implement Threads API publishing
    // Step 1: POST /{threads-user-id}/threads → create container
    // Step 2: POST /{threads-user-id}/threads_publish → publish
    throw new Error(`ThreadsPublisher not yet implemented for ${target.id}`);
  }
}
