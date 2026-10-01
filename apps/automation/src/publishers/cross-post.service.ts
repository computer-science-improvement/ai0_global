import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetaCrosspostTargetsRepository } from '../config/meta-crosspost-targets.repository';
import { ChannelConfigService } from '../config/channel-config.service';
import { SettingsService } from '../settings/settings.service';
import { SecretsService } from '../common/crypto/secrets.service';
import { PostingThrottleService } from './posting-throttle.service';
import { PublisherDispatcher } from './publisher-dispatcher.service';
import { buildMirrorCaption, buildTeaserCaption, tgPostLink } from './crosspost-content';
import type { MetaPlatform } from '../config/meta-accounts.repository';

export interface MirrorContent { text: string; tags: string[]; imageUrl?: string }
export interface TeaserContent { lines: string[]; imageUrl?: string }

/** A ready caption + images for one platform (editor renderMeta). `caption` goes through the publishers' HTML→plain step. */
export interface RenderedCrossPost { caption: string; imageUrls: string[]; carousel: boolean }

export interface CrossPostInput {
  channelKey:       string;                 // channel_key or id (resolved internally)
  messageId:        string | number;
  mirror?:          MirrorContent;          // provided by mirror-mode callers
  teaser?:          TeaserContent;          // provided by teaser-mode callers (e.g. recipes)
  /**
   * Per-platform content from the caller (editor agent). When set it is used
   * for every target regardless of mode; null skips that platform.
   * `link` is the public t.me link of the just-published post (or null).
   */
  render?:          (platform: MetaPlatform, link: string | null) => RenderedCrossPost | null;
}

/** What happened to one cross-post target. Legacy callers ignore it; the editor records failures. */
export interface CrossPostOutcome {
  platform: string;
  status:   'ok' | 'skipped' | 'failed';
  detail?:  string;
}

/**
 * Fan a just-published Telegram post out to the channel's enabled Meta
 * cross-post targets. NEVER throws to the caller — a Meta failure must not
 * affect the Telegram publish or sibling targets. Each attempt respects a
 * per-account cooldown so multiple strategies can't flood one account.
 */
@Injectable()
export class CrossPostService {
  private readonly logger = new Logger(CrossPostService.name);

  constructor(
    private readonly targets:    MetaCrosspostTargetsRepository,
    private readonly channels:   ChannelConfigService,
    private readonly dispatcher: PublisherDispatcher,
    private readonly throttle:   PostingThrottleService,
    private readonly settings:   SettingsService,
    private readonly config:     ConfigService,
    private readonly secrets:    SecretsService,
  ) {}

  async afterPublish(input: CrossPostInput): Promise<CrossPostOutcome[]> {
    const outcomes: CrossPostOutcome[] = [];
    const skip = (platform: string, detail: string) => { outcomes.push({ platform, status: 'skipped', detail }); };
    const meta = this.channels.getChannelMeta(input.channelKey);
    if (!meta) return outcomes;

    let targets;
    try {
      targets = await this.targets.listEnabledResolved(meta.id);
    } catch (err: any) {
      this.logger.warn(`crosspost: failed to load targets: ${err.message}`);
      return [{ platform: '*', status: 'failed', detail: `targets: ${err.message}` }];
    }
    if (!targets.length) return outcomes;

    const link = tgPostLink(meta.username, input.messageId);

    for (const t of targets) {
      try {
        if (!t.account_active) { this.logger.debug(`crosspost skip ${t.platform}: account inactive`); skip(t.platform, 'account inactive'); continue; }
        // Same resolution as DestinationResolver: encrypted token_enc first,
        // legacy token_env → env var as the fallback.
        const token = this.secrets.resolveToken(
          { enc: t.account_token_enc, env: t.account_token_env }, (k) => this.config.get<string>(k),
        );
        if (!token) {
          this.logger.warn(`crosspost skip ${t.platform}: no token (token_enc empty, env ${t.account_token_env ?? '-'} not set)`);
          outcomes.push({ platform: t.platform, status: 'failed', detail: 'no access token' });
          continue;
        }

        // Build content for this target's mode; skip if the caller didn't supply it.
        let text: string;
        let imageUrl: string | undefined;
        let carouselUrls: string[] | null = null;
        if (input.render) {
          const r = input.render(t.platform, link);
          if (!r) { this.logger.debug(`crosspost skip ${t.platform}: not rendered for this platform`); skip(t.platform, 'not supported for this post'); continue; }
          text = r.caption;
          imageUrl = r.imageUrls[0];
          if (r.carousel && r.imageUrls.length >= 2) carouselUrls = r.imageUrls;
        } else if (t.mode === 'teaser') {
          if (!input.teaser) { this.logger.debug(`crosspost skip ${t.platform}: no teaser content`); skip(t.platform, 'no teaser content'); continue; }
          text = buildTeaserCaption(t.platform, input.teaser.lines, link);
          imageUrl = input.teaser.imageUrl;
        } else {
          if (!input.mirror) { this.logger.debug(`crosspost skip ${t.platform}: no mirror content`); skip(t.platform, 'no mirror content'); continue; }
          text = buildMirrorCaption(t.platform, input.mirror.text, input.mirror.tags, link);
          imageUrl = input.mirror.imageUrl;
        }

        // Instagram requires a public image; skip imageless content quietly
        // instead of letting the IG publisher throw (text-only strategies with
        // an IG target attached stay clean in the logs).
        if (t.platform === 'instagram' && !imageUrl) {
          this.logger.debug('crosspost skip instagram: no image');
          skip(t.platform, 'no image');
          continue;
        }

        // Per-account cooldown (key by meta account, per-platform window).
        const key = `meta:${t.meta_account_id}`;
        const cooldownMs = this.settings.metaCooldownMin(t.platform) * 60_000;
        if (!this.throttle.tryLock(key, cooldownMs)) {
          this.logger.debug(`crosspost skip ${t.platform}: cooldown active on ${t.meta_account_id}`);
          skip(t.platform, 'cooldown');
          continue;
        }

        try {
          const target = { id: t.account_target_id, token };
          const id = carouselUrls
            ? await this.dispatcher.publishCarousel(t.platform, { text, source: link ?? '', tags: [] }, carouselUrls, target)
            : await this.dispatcher.publish(t.platform, { text, imageUrl, source: link ?? '', tags: [] }, target);
          this.throttle.recordPublish(key);
          this.logger.log(`crosspost → ${t.platform} ok (${id})`);
          outcomes.push({ platform: t.platform, status: 'ok', detail: String(id) });
        } catch (err: any) {
          this.throttle.releaseLock(key);
          this.logger.warn(`crosspost → ${t.platform} failed: ${err.message}`);
          outcomes.push({ platform: t.platform, status: 'failed', detail: err.message });
        }
      } catch (err: any) {
        this.logger.warn(`crosspost target error (${t.platform}): ${err.message}`);
        outcomes.push({ platform: t.platform, status: 'failed', detail: err.message });
      }
    }
    return outcomes;
  }
}
