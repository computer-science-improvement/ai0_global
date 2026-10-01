import { escapeHtml } from '../post/inline-markup';
import { parseResourceRef } from '../agents/agent.types';
import type { RenderedPlatformPost } from './platform-spec';

type MetaPlatform = 'instagram' | 'facebook' | 'threads';

export interface MetaAccountTarget {
  platform: MetaPlatform;
  targetId: string;
  token:    string | null;
  active:   boolean;
  username: string | null;
}

export interface ResourcePublisherDeps {
  /** meta_accounts row by id with its token resolved (token_enc, then token_env). */
  metaAccount(id: string): Promise<MetaAccountTarget | null>;
  dispatcher: {
    publish(platform: MetaPlatform, payload: { text: string; imageUrl?: string; source: string; tags: string[] }, target: { id: string; token: string }): Promise<string>;
    publishCarousel(platform: MetaPlatform, payload: { text: string; source: string; tags: string[] }, imageUrls: string[], target: { id: string; token: string }): Promise<string>;
  };
  tiktok: { publishCarousel(accountId: string, imageUrls: string[], caption: string): Promise<string> };
  /** Instagram "first comment" (best effort; failure is a warning). */
  igComment?: (mediaId: string, token: string, message: string) => Promise<void>;
}

export interface PublishedRef {
  externalId: string;
  url:        string | null;
  warnings:   string[];
}

/**
 * One publish entry point for every non-Telegram resource (spec 019 FR-005).
 * Meta captions pass through the publishers' HTML→plain step, so the plain
 * caption is HTML-escaped here to survive verbatim (as the 009 mirrors do).
 */
export class ResourcePublisher {
  constructor(private readonly d: ResourcePublisherDeps) {}

  async publish(resourceRef: string, r: RenderedPlatformPost): Promise<PublishedRef> {
    const ref = parseResourceRef(resourceRef);
    if (!ref) throw new Error(`invalid resource ${resourceRef}`);
    const warnings: string[] = [];

    switch (ref.platform) {
      case 'instagram':
      case 'facebook':
      case 'threads': {
        const acct = await this.d.metaAccount(ref.id);
        if (!acct || !acct.active) throw new Error(`${ref.platform} account ${ref.id} is missing or inactive`);
        if (acct.platform !== ref.platform) throw new Error(`account ${ref.id} is ${acct.platform}, not ${ref.platform}`);
        if (!acct.token) throw new Error(`${ref.platform} account ${ref.id}: no access token`);
        const target = { id: acct.targetId, token: acct.token };
        const text = escapeHtml(r.caption);
        if (ref.platform === 'instagram' && !r.imageUrls.length) throw new Error('Instagram needs at least one image');
        const id = r.carousel
          ? await this.d.dispatcher.publishCarousel(ref.platform, { text, source: r.link ?? '', tags: [] }, r.imageUrls, target)
          : await this.d.dispatcher.publish(ref.platform, { text, imageUrl: r.imageUrls[0], source: r.link ?? '', tags: [] }, target);
        if (ref.platform === 'instagram' && r.firstComment && this.d.igComment) {
          try { await this.d.igComment(id, acct.token, r.firstComment); } catch (err: any) { warnings.push(`first_comment: ${err?.message ?? err}`); }
        }
        const url = ref.platform === 'facebook' ? `https://www.facebook.com/${id}`
          : ref.platform === 'threads' && acct.username ? `https://www.threads.net/@${acct.username}/post/${id}` : null;
        return { externalId: String(id), url, warnings };
      }
      case 'tiktok': {
        if (!r.imageUrls.length) throw new Error('TikTok photo mode needs at least one image');
        const caption = [r.title, r.caption].filter(Boolean).join('\n\n');
        const publishId = await this.d.tiktok.publishCarousel(ref.id, r.imageUrls, caption);
        return { externalId: publishId, url: null, warnings };
      }
      case 'youtube':
        throw new Error('not_implemented: YouTube publishing arrives with spec 019b (video)');
      default:
        throw new Error(`telegram resources publish through the Telegram path, not ResourcePublisher`);
    }
  }
}
