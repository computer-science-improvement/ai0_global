import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostPayload } from '../common/types';
import { BasePublisher, PublishTarget } from './base.publisher';
import { buildCaption } from './meta-content';
import { FACEBOOK_GRAPH, graphPost, graphTimeout, graphVersion } from './meta-graph.util';

// Docs: https://developers.facebook.com/docs/pages-api/posts
// target.id = Page id, target.token = Page access token (resolved upstream).
@Injectable()
export class FacebookPublisher extends BasePublisher {
  readonly platform = 'facebook';

  constructor(private readonly config: ConfigService) {
    super();
  }

  async publish(payload: PostPayload, target: PublishTarget): Promise<string> {
    const token = target.token;
    if (!token) throw new Error('Facebook publish: missing access token');

    const caption = buildCaption(payload.text, payload.tags, { maxLen: 60000, maxTags: 0 });
    const ver = graphVersion(this.config);
    const timeout = graphTimeout(this.config);

    // Photo post when an image URL is available, else a plain feed post.
    const data = payload.imageUrl
      ? await graphPost(`${FACEBOOK_GRAPH}/${ver}/${target.id}/photos`,
          { url: payload.imageUrl, caption, access_token: token }, timeout, token)
      : await graphPost(`${FACEBOOK_GRAPH}/${ver}/${target.id}/feed`,
          { message: caption, access_token: token }, timeout, token);

    return String(data.post_id ?? data.id ?? '');
  }
}
