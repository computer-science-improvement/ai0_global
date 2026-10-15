// destination-resolver.service.ts — the account-group fan-out lookups (spec 024): which group a publish
// destination belongs to and the group's other members. The binding → destination resolution of the legacy
// strategy runtime was removed with it (spec 023 phase B).
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetaAccountsRepository } from '../../config/meta-accounts.repository';
import { TikTokAccountsRepository } from '../../config/tiktok-accounts.repository';
import { SecretsService } from '../crypto/secrets.service';
import { PublishDestination, META_POSTED_PREFIX } from './publish-destination';
import { MetaAccountGroupsRepository } from '../../config/meta-account-groups.repository';
import { TrackedChannelsRepository } from '../../tracking/repositories/tracked-channels.repository';

@Injectable()
export class DestinationResolver {
  constructor(
    private readonly metaAccounts: MetaAccountsRepository,
    private readonly config: ConfigService,
    private readonly tiktok: TikTokAccountsRepository,
    private readonly secrets: SecretsService,
    private readonly groups: MetaAccountGroupsRepository,
    private readonly channels: TrackedChannelsRepository,
  ) {}

  /**
   * Resolve the group a publish destination belongs to and whether THIS dest is
   * the group's designated fan-out source. Returns null when the dest is not in
   * any group (then no fan-out happens).
   */
  async resolveGroupForDest(
    dest: PublishDestination,
  ): Promise<{ groupId: string; sourcePlatform: string; isSource: boolean } | null> {
    let groupId: string | null = null;
    let memberPlatform: string = dest.platform;

    if (dest.platform === 'telegram') {
      groupId = await this.channels.findGroupIdByChannelKey(dest.targetId);
      memberPlatform = 'telegram';
    } else if (dest.metaAccountId) {
      const acct = await this.metaAccounts.findById(dest.metaAccountId);
      groupId = acct?.group_id ?? null;
      memberPlatform = acct?.platform ?? dest.platform;
    }
    if (!groupId) return null;

    const group = await this.groups.findById(groupId);
    if (!group) return null;
    return {
      groupId,
      sourcePlatform: group.source_platform,
      isSource: group.source_platform === memberPlatform,
    };
  }

  /**
   * Every OTHER active member of a group as a ready-to-publish destination —
   * the Meta accounts (with resolved tokens) and the linked Telegram channel.
   * `excludePlatform` is the source's platform (its own member is skipped).
   * Meta members with no usable token are skipped. The Telegram member is
   * skipped when the group has none. The Telegram destination's bot is resolved
   * later by TelegramPublisher (via channel config), so no token is attached.
   */
  async resolveGroupTargets(
    groupId: string,
    excludePlatform: string,
  ): Promise<PublishDestination[]> {
    const out: PublishDestination[] = [];

    const metas = await this.metaAccounts.findActiveByGroup(groupId);
    for (const acct of metas) {
      if (acct.platform === excludePlatform) continue;
      const token = this.secrets.resolveToken(
        { enc: acct.token_enc, env: acct.token_env }, (k) => this.config.get<string>(k),
      );
      if (!token) continue;
      out.push({
        platform: acct.platform,
        targetId: acct.target_id,
        token,
        metaAccountId: acct.id,
        postedKey: `${META_POSTED_PREFIX[acct.platform]}:${acct.id}`,
        throttleKey: `meta:${acct.id}`,
      });
    }

    // TikTok accounts can join a network too (spec 019); they get photo posts through the TikTok publisher.
    if (excludePlatform !== 'tiktok' && typeof this.tiktok.findActiveByGroup === 'function') {
      for (const acct of await this.tiktok.findActiveByGroup(groupId)) {
        out.push({
          platform: 'tiktok',
          targetId: acct.id,
          metaAccountId: null,
          postedKey: `TT:${acct.id}`,
          throttleKey: `tiktok:${acct.id}`,
        });
      }
    }

    if (excludePlatform !== 'telegram') {
      const ch = await this.channels.findByGroupId(groupId);
      if (ch?.channelKey) {
        out.push({
          platform: 'telegram',
          targetId: ch.channelKey,
          metaAccountId: null,
          postedKey: 'TELEGRAM',
          throttleKey: ch.channelKey,
        });
      }
    }

    return out;
  }
}
