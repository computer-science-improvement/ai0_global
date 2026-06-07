import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetaCrosspostTargetsRepository } from '../config/meta-crosspost-targets.repository';
import { ChannelConfigService } from '../config/channel-config.service';
import { SettingsService } from '../settings/settings.service';
import { PostingThrottleService } from './posting-throttle.service';
import { PublisherDispatcher } from './publisher-dispatcher.service';
import { buildMirrorCaption, buildTeaserCaption, tgPostLink } from './crosspost-content';

export interface MirrorContent { text: string; tags: string[]; imageUrl?: string }
export interface TeaserContent { lines: string[]; imageUrl?: string }

export interface CrossPostInput {
  channelKey:       string;                 // channel_key or id (resolved internally)
  messageId:        string | number;
  mirror?:          MirrorContent;          // provided by mirror-mode callers
  teaser?:          TeaserContent;          // provided by teaser-mode callers (e.g. recipes)
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
  ) {}

  async afterPublish(input: CrossPostInput): Promise<void> {
    const meta = this.channels.getChannelMeta(input.channelKey);
    if (!meta) return;

    let targets;
    try {
      targets = await this.targets.listEnabledResolved(meta.id);
    } catch (err: any) {
      this.logger.warn(`crosspost: failed to load targets: ${err.message}`);
      return;
    }
    if (!targets.length) return;

    const link = tgPostLink(meta.username, input.messageId);

    for (const t of targets) {
      try {
        if (!t.account_active) { this.logger.debug(`crosspost skip ${t.platform}: account inactive`); continue; }
        const token = this.config.get<string>(t.account_token_env);
        if (!token) { this.logger.warn(`crosspost skip ${t.platform}: env ${t.account_token_env} not set`); continue; }

        // Build content for this target's mode; skip if the caller didn't supply it.
        let text: string;
        let imageUrl: string | undefined;
        if (t.mode === 'teaser') {
          if (!input.teaser) { this.logger.debug(`crosspost skip ${t.platform}: no teaser content`); continue; }
          text = buildTeaserCaption(t.platform, input.teaser.lines, link);
          imageUrl = input.teaser.imageUrl;
        } else {
          if (!input.mirror) { this.logger.debug(`crosspost skip ${t.platform}: no mirror content`); continue; }
          text = buildMirrorCaption(t.platform, input.mirror.text, input.mirror.tags, link);
          imageUrl = input.mirror.imageUrl;
        }

        // Per-account cooldown (key by meta account, per-platform window).
        const key = `meta:${t.meta_account_id}`;
        const cooldownMs = this.settings.metaCooldownMin(t.platform) * 60_000;
        if (!this.throttle.tryLock(key, cooldownMs)) {
          this.logger.debug(`crosspost skip ${t.platform}: cooldown active on ${t.meta_account_id}`);
          continue;
        }

        try {
          const id = await this.dispatcher.publish(
            t.platform,
            { text, imageUrl, source: link ?? '', tags: [] },
            { id: t.account_target_id, token },
          );
          this.throttle.recordPublish(key);
          this.logger.log(`crosspost → ${t.platform} ok (${id})`);
        } catch (err: any) {
          this.throttle.releaseLock(key);
          this.logger.warn(`crosspost → ${t.platform} failed: ${err.message}`);
        }
      } catch (err: any) {
        this.logger.warn(`crosspost target error (${t.platform}): ${err.message}`);
      }
    }
  }
}
