import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostPayload } from '../common/types';
import { BasePublisher, PublishTarget } from './base.publisher';
import { assertCarouselSize, joinChildren } from './meta-carousel';
import { buildCaption } from './meta-content';
import { FACEBOOK_GRAPH, graphPost, graphTimeout, graphVersion } from './meta-graph.util';

// Docs: https://developers.facebook.com/docs/instagram-api/guides/content-publishing
// target.id = IG business-account id, target.token = access token.
// IG cannot post text-only — it fetches a public image_url.
@Injectable()
export class InstagramPublisher extends BasePublisher {
  readonly platform = 'instagram';

  constructor(private readonly config: ConfigService) {
    super();
  }

  async publish(payload: PostPayload, target: PublishTarget): Promise<string> {
    const token = target.token;
    if (!token) throw new Error('Instagram publish: missing access token');
    if (!payload.imageUrl) throw new Error('Instagram needs a public image URL (no hosting in Phase 2)');

    const caption = buildCaption(payload.text, payload.tags, { maxLen: 2200, maxTags: 30 });
    const ver = graphVersion(this.config);
    const timeout = graphTimeout(this.config);
    const root = `${FACEBOOK_GRAPH}/${ver}/${target.id}`;

    // Step 1: create media container.
    const container = await graphPost(`${root}/media`,
      { image_url: payload.imageUrl, caption, access_token: token }, timeout, token);
    const creationId = String(container.id ?? '');
    if (!creationId) throw new Error('Instagram: no creation id returned');

    // Step 2: publish the container.
    const published = await graphPost(`${root}/media_publish`,
      { creation_id: creationId, access_token: token }, timeout, token);
    return String(published.id ?? creationId);
  }

  /** Graph POST seam — overridable in tests. Only publishCarousel routes through
   *  it; the single-image publish() above calls graphPost directly. */
  protected post(url: string, params: Record<string, string>): Promise<any> {
    return graphPost(url, params, graphTimeout(this.config), params.access_token);
  }

  async publishCarousel(payload: PostPayload, imageUrls: string[], target: PublishTarget): Promise<string> {
    const token = target.token;
    if (!token) throw new Error('Instagram carousel: missing access token');
    assertCarouselSize(imageUrls.length, 10, 'instagram');

    const caption = buildCaption(payload.text, payload.tags, { maxLen: 2200, maxTags: 30 });
    const ver = graphVersion(this.config);
    const root = `${FACEBOOK_GRAPH}/${ver}/${target.id}`;

    // Step 1: one item container per image.
    const children: string[] = [];
    for (const url of imageUrls) {
      const item = await this.post(`${root}/media`,
        { image_url: url, is_carousel_item: 'true', access_token: token });
      const itemId = String(item.id ?? '');
      if (!itemId) throw new Error('Instagram carousel: no item container id');
      children.push(itemId);
    }

    // Step 2: the CAROUSEL parent container.
    const parent = await this.post(`${root}/media`,
      { media_type: 'CAROUSEL', children: joinChildren(children), caption, access_token: token });
    const creationId = String(parent.id ?? '');
    if (!creationId) throw new Error('Instagram carousel: no parent creation id');

    // Step 3: publish.
    const published = await this.post(`${root}/media_publish`,
      { creation_id: creationId, access_token: token });
    return String(published.id ?? creationId);
  }
}
