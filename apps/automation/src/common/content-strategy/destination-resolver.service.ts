// destination-resolver.service.ts — turn a resolved binding into the concrete
// place a strategy publishes to, resolving the Meta access token from env
// (mirrors CrossPostService's `config.get(token_env)` pattern).
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetaAccountsRepository } from '../../config/meta-accounts.repository';
import { TikTokAccountsRepository } from '../../config/tiktok-accounts.repository';
import { SecretsService } from '../crypto/secrets.service';
import type { ResolvedStrategyBinding } from '../../config/channel-config.service';
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

  async resolve(b: ResolvedStrategyBinding): Promise<PublishDestination> {
    if (b.platform === 'telegram') {
      return {
        platform: 'telegram',
        targetId: b.channelId,
        // token omitted — undefined by design for Telegram
        metaAccountId: null,
        postedKey: 'TELEGRAM',
        throttleKey: b.channelId,
      };
    }

    if (b.platform === 'tiktok') {
      if (!b.tiktokAccountId) throw new Error(`binding ${b.id}: platform tiktok requires a tiktok_account_id`);
      const acct = await this.tiktok.findById(b.tiktokAccountId);
      if (!acct) throw new Error(`binding ${b.id}: tiktok account ${b.tiktokAccountId} not found`);
      if (!acct.active) throw new Error(`binding ${b.id}: tiktok account ${acct.id} is inactive`);
      return {
        platform: 'tiktok',
        targetId: acct.id,
        metaAccountId: null,
        postedKey: `TT:${acct.id}`,
        throttleKey: `tiktok:${acct.id}`,
      };
    }

    if (!b.metaAccountId) {
      throw new Error(`binding ${b.id}: platform ${b.platform} requires a meta_account_id`);
    }
    const acct = await this.metaAccounts.findById(b.metaAccountId);
    if (!acct) throw new Error(`binding ${b.id}: meta account ${b.metaAccountId} not found`);
    if (!acct.active) throw new Error(`binding ${b.id}: meta account ${acct.id} is inactive`);
    const token = this.secrets.resolveToken(
      { enc: acct.token_enc, env: acct.token_env }, (k) => this.config.get<string>(k),
    );
    if (!token) throw new Error(`binding ${b.id}: token env ${acct.token_env} not set`);

    return {
      platform: acct.platform,
      targetId: acct.target_id,
      token,
      metaAccountId: acct.id,
      postedKey: `${META_POSTED_PREFIX[acct.platform]}:${acct.id}`,
      throttleKey: `meta:${acct.id}`,
    };
  }

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
