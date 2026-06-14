import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostPayload } from '../common/types';
import { BasePublisher, PublishTarget } from './base.publisher';
import { buildCaption } from './meta-content';
import { THREADS_GRAPH, graphPost, graphTimeout, threadsVersion } from './meta-graph.util';
import { assertCarouselSize, joinChildren } from './meta-carousel';

// Docs: https://developers.facebook.com/docs/threads/posts
// target.id = Threads user id, target.token = access token. Posts capped 500 chars.
@Injectable()
export class ThreadsPublisher extends BasePublisher {
  readonly platform = 'threads';

  constructor(private readonly config: ConfigService) {
    super();
  }

  async publish(payload: PostPayload, target: PublishTarget): Promise<string> {
    const token = target.token;
    if (!token) throw new Error('Threads publish: missing access token');

    const text = buildCaption(payload.text, payload.tags, { maxLen: 500, maxTags: 0 });
    const ver = threadsVersion(this.config);
    const timeout = graphTimeout(this.config);
    const root = `${THREADS_GRAPH}/${ver}/${target.id}`;

    const createParams: Record<string, string> = payload.imageUrl
      ? { media_type: 'IMAGE', image_url: payload.imageUrl, text, access_token: token }
      : { media_type: 'TEXT', text, access_token: token };

    // Step 1: create container.
    const container = await graphPost(`${root}/threads`, createParams, timeout, token);
    const creationId = String(container.id ?? '');
    if (!creationId) throw new Error('Threads: no creation id returned');

    // Step 2: publish.
    const published = await graphPost(`${root}/threads_publish`,
      { creation_id: creationId, access_token: token }, timeout, token);
    return String(published.id ?? creationId);
  }

  /** Graph POST seam — overridable in tests. */
  protected post(url: string, params: Record<string, string>): Promise<any> {
    return graphPost(url, params, graphTimeout(this.config), params.access_token);
  }

  async publishCarousel(payload: PostPayload, imageUrls: string[], target: PublishTarget): Promise<string> {
    const token = target.token;
    if (!token) throw new Error('Threads carousel: missing access token');
    assertCarouselSize(imageUrls.length, 20, 'threads');

    const text = buildCaption(payload.text, payload.tags, { maxLen: 500, maxTags: 0 });
    const ver = threadsVersion(this.config);
    const root = `${THREADS_GRAPH}/${ver}/${target.id}`;

    // Step 1: one IMAGE item container per image.
    const children: string[] = [];
    for (const url of imageUrls) {
      const item = await this.post(`${root}/threads`,
        { media_type: 'IMAGE', image_url: url, is_carousel_item: 'true', access_token: token });
      const itemId = String(item.id ?? '');
      if (!itemId) throw new Error('Threads carousel: no item container id');
      children.push(itemId);
    }

    // Step 2: the CAROUSEL parent container.
    const parent = await this.post(`${root}/threads`,
      { media_type: 'CAROUSEL', children: joinChildren(children), text, access_token: token });
    const creationId = String(parent.id ?? '');
    if (!creationId) throw new Error('Threads carousel: no parent creation id');

    // Step 3: publish.
    const published = await this.post(`${root}/threads_publish`,
      { creation_id: creationId, access_token: token });
    return String(published.id ?? creationId);
  }
}
