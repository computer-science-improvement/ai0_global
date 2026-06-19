import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostPayload } from '../common/types';
import { BasePublisher, PublishTarget } from './base.publisher';
import { buildCaption } from './meta-content';
import { FACEBOOK_GRAPH, graphGet, graphPost, graphTimeout, graphVersion } from './meta-graph.util';
import { assertCarouselSize, fbAttachedMedia } from './meta-carousel';

// Docs: https://developers.facebook.com/docs/pages-api/posts
// target.id = Page id, target.token = Page access token.
//
// The token stored for an account may be a SYSTEM_USER or USER token (great for
// reads/insights), but publishing — especially UNPUBLISHED album photos — must
// be done "as the page itself", i.e. with the PAGE access token (else Graph
// returns (#200) "Unpublished posts must be posted to a page as the page
// itself."). A SYSTEM_USER/USER token that manages the page can MINT the page
// token via GET /{page-id}?fields=access_token, so we derive it transparently
// and cache it per page. A request made WITH a page token returns that same
// page token, so this is a safe no-op for accounts already holding one.
@Injectable()
export class FacebookPublisher extends BasePublisher {
  readonly platform = 'facebook';
  private readonly logger = new Logger(FacebookPublisher.name);
  /** pageId → { token, at } page-token cache (page tokens are long-lived). */
  private readonly pageTokenCache = new Map<string, { token: string; at: number }>();
  private static readonly PAGE_TOKEN_TTL_MS = 30 * 60 * 1000;

  constructor(private readonly config: ConfigService) {
    super();
  }

  /**
   * Resolve the PAGE access token for `pageId`, deriving it from the supplied
   * token when that token isn't already the page's own. Falls back to the
   * supplied token if derivation fails (e.g. the token IS a page token but the
   * field read is blocked) so behaviour never regresses.
   */
  protected async pageToken(pageId: string, token: string): Promise<string> {
    const cached = this.pageTokenCache.get(pageId);
    if (cached && Date.now() - cached.at < FacebookPublisher.PAGE_TOKEN_TTL_MS) {
      return cached.token;
    }
    try {
      const ver = graphVersion(this.config);
      const data = await graphGet(
        `${FACEBOOK_GRAPH}/${ver}/${pageId}`,
        { fields: 'access_token', access_token: token },
        graphTimeout(this.config),
        token,
      );
      const pageTok = String(data?.access_token ?? '');
      if (pageTok) {
        this.pageTokenCache.set(pageId, { token: pageTok, at: Date.now() });
        return pageTok;
      }
    } catch (err: any) {
      this.logger.warn(`page-token derive failed for ${pageId}: ${err.message} — using supplied token`);
    }
    return token;
  }

  async publish(payload: PostPayload, target: PublishTarget): Promise<string> {
    if (!target.token) throw new Error('Facebook publish: missing access token');
    const token = await this.pageToken(target.id, target.token);

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

  /** Graph POST seam — overridable in tests. Only publishCarousel routes through
   *  it; the single-image publish() above calls graphPost directly. */
  protected post(url: string, params: Record<string, string>): Promise<any> {
    return graphPost(url, params, graphTimeout(this.config), params.access_token);
  }

  // NOTE: on a partial failure (a later photo upload throws), the earlier
  // `published:false` photos are knowingly left on the Page's photo store — FB
  // does not reliably auto-prune unpublished photos. Accepted slack; no cleanup.
  async publishCarousel(payload: PostPayload, imageUrls: string[], target: PublishTarget): Promise<string> {
    if (!target.token) throw new Error('Facebook album: missing access token');
    const token = await this.pageToken(target.id, target.token);
    assertCarouselSize(imageUrls.length, 10, 'facebook');

    const caption = buildCaption(payload.text, payload.tags, { maxLen: 60000, maxTags: 0 });
    const ver = graphVersion(this.config);
    const base = `${FACEBOOK_GRAPH}/${ver}/${target.id}`;

    // Step 1: upload each photo unpublished → collect media_fbid.
    const fbids: string[] = [];
    for (const url of imageUrls) {
      const photo = await this.post(`${base}/photos`,
        { url, published: 'false', access_token: token });
      const photoId = String(photo.id ?? '');
      if (!photoId) throw new Error('Facebook album: no photo id');
      fbids.push(photoId);
    }

    // Step 2: a single feed post attaching all photos.
    const post = await this.post(`${base}/feed`,
      { message: caption, attached_media: fbAttachedMedia(fbids), access_token: token });
    return String(post.post_id ?? post.id ?? '');
  }
}
