import type { EditorCard } from '../card';
import type { PostSpec } from '../post/post-spec';
import type { PreparedMedia } from '../post/render-telegram';
import { escapeHtml } from '../post/inline-markup';
import { MirrorPlatform, MirrorPost, renderMeta } from '../post/render-meta';
import type { CrossPostInput, CrossPostOutcome, RenderedCrossPost } from '../../publishers/cross-post.service';
import type { FanOutOutcome, GroupContent } from '../../common/content-strategy/group-fanout.service';
import type { PublishDestination } from '../../common/content-strategy/publish-destination';

export interface EditorCrossPostDeps {
  /** CrossPostService: the channel's meta_crosspost_targets (what every Telegram strategy uses). */
  crossPost:   { afterPublish(input: CrossPostInput): Promise<CrossPostOutcome[] | void> };
  /** GroupFanOutService: Meta members of the channel's account group when Telegram is the group source. */
  groupFanOut: { fanOut(source: PublishDestination, content: GroupContent, markPosted: (key: string) => Promise<void>): Promise<FanOutOutcome[] | void> };
  /** Public t.me link of a post (null for private channels); used as the link back on the group path. */
  postLink(channelKey: string, messageId: number): string | null;
  /**
   * Spec 024 FR-003: the one gate for automatic duplication
   * (NetworkRepository.autoDuplicateActiveForChannel). False → no fan-out at all:
   * neither the channel's crosspost targets nor the group members.
   */
  autoDuplicateActive?(channelKey: string): Promise<boolean>;
  /**
   * Spec 025 FR-013: platforms whose mirror resource of this channel is paused by a pause_resource directive;
   * they get no copy while the pause is active.
   */
  pausedPlatforms?(channelKey: string): Promise<Set<string>>;
}

export interface CrossPostRequest {
  channelKey: string;
  messageId:  number;
  spec:       PostSpec;
  card:       Pick<EditorCard, 'footer'>;
  prepared:   PreparedMedia;
}

/**
 * The Meta publishers run every caption through htmlToPlainText, so the plain
 * text from renderMeta is HTML-escaped here to survive that step verbatim.
 */
function forPublisher(p: MirrorPost | undefined): RenderedCrossPost | null {
  return p ? { caption: escapeHtml(p.caption), imageUrls: p.imageUrls, carousel: p.carousel && p.imageUrls.length >= 2 } : null;
}

/**
 * Fan a LIVE editor post out to the channel's mirrors through the existing
 * mechanisms (spec 009 T003). Never throws: returns one warning per failed
 * target ("crosspost: instagram: …"), which publish_post stores on the slot.
 * Dedup is the editor's published_posts row, so markPosted is a no-op.
 */
export class EditorCrossPoster {
  constructor(private readonly d: EditorCrossPostDeps) {}

  async fanOut(r: CrossPostRequest): Promise<string[]> {
    const warnings: string[] = [];
    if (this.d.autoDuplicateActive) {
      try { if (!(await this.d.autoDuplicateActive(r.channelKey))) return warnings; } catch { /* unknown → keep duplicating as before */ }
    }
    let paused = new Set<string>();
    if (this.d.pausedPlatforms) {
      try { paused = await this.d.pausedPlatforms(r.channelKey); } catch { /* unknown → no pause filter */ }
    }
    const render = (platform: MirrorPlatform, link: string | null) =>
      (paused.has(platform) ? null : forPublisher(renderMeta(r.spec, r.card, r.prepared, { telegramLink: link }).posts[platform]));
    const record = (outs: Array<CrossPostOutcome | FanOutOutcome> | void) => {
      for (const o of outs ?? []) if (o.status === 'failed') warnings.push(`crosspost: ${o.platform}: ${o.detail ?? 'failed'}`);
    };

    try {
      record(await this.d.crossPost.afterPublish({ channelKey: r.channelKey, messageId: r.messageId, render }));
    } catch (err: any) {
      warnings.push(`crosspost: ${err?.message ?? err}`);
    }

    try {
      const link = this.d.postLink(r.channelKey, r.messageId);
      const source: PublishDestination = {
        platform: 'telegram', targetId: r.channelKey, metaAccountId: null, postedKey: 'TELEGRAM', throttleKey: r.channelKey,
      };
      record(await this.d.groupFanOut.fanOut(source, {
        caption: '', tags: [], imageUrls: [], carousel: false,
        render: (platform) => (platform === 'telegram' ? null : render(platform, link)),
      }, async () => {}));
    } catch (err: any) {
      warnings.push(`crosspost: group: ${err?.message ?? err}`);
    }
    return warnings;
  }
}
