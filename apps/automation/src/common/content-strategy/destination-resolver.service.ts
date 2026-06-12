// destination-resolver.service.ts — turn a resolved binding into the concrete
// place a strategy publishes to, resolving the Meta access token from env
// (mirrors CrossPostService's `config.get(token_env)` pattern).
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetaAccountsRepository } from '../../config/meta-accounts.repository';
import type { ResolvedStrategyBinding } from '../../config/channel-config.service';
import { PublishDestination, META_POSTED_PREFIX } from './publish-destination';

@Injectable()
export class DestinationResolver {
  constructor(
    private readonly metaAccounts: MetaAccountsRepository,
    private readonly config: ConfigService,
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

    if (!b.metaAccountId) {
      throw new Error(`binding ${b.id}: platform ${b.platform} requires a meta_account_id`);
    }
    const acct = await this.metaAccounts.findById(b.metaAccountId);
    if (!acct) throw new Error(`binding ${b.id}: meta account ${b.metaAccountId} not found`);
    if (!acct.active) throw new Error(`binding ${b.id}: meta account ${acct.id} is inactive`);
    const token = this.config.get<string>(acct.token_env);
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
}
