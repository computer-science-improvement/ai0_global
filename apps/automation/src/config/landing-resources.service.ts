// apps/automation/src/config/landing-resources.service.ts
import { Injectable } from '@nestjs/common';
import { MetaAccountsRepository } from './meta-accounts.repository';
import { TikTokAccountsRepository } from './tiktok-accounts.repository';
import { TrackedChannelsConfigRepository } from './tracked-channels.repository';

export type LandingPlatform = 'telegram' | 'instagram' | 'facebook' | 'threads' | 'tiktok';

export interface LandingResource {
  platform: LandingPlatform;
  handle: string | null;        // username (telegram: channel_key without leading @, falling back to username)
  displayName: string | null;   // title / display_name
  avatarUrl: string | null;     // picture_url / avatar_url; null for telegram
  followerCount: number | null; // subs_count / followers; null for tiktok
  url: string | null;           // derived from handle
  order: number;                // landing_order
}

/** Pure, unit-testable: derive a public profile url from a handle. */
export function landingUrl(platform: LandingPlatform, handle: string | null): string | null {
  if (handle === null) return null;
  switch (platform) {
    case 'telegram':  return `https://t.me/${handle}`;
    case 'instagram': return `https://www.instagram.com/${handle}`;
    case 'facebook':  return `https://www.facebook.com/${handle}`;
    case 'threads':   return `https://www.threads.net/@${handle}`;
    case 'tiktok':    return `https://www.tiktok.com/@${handle}`;
  }
}

function stripAt(value: string | null): string | null {
  if (value === null) return null;
  return value.startsWith('@') ? value.slice(1) : value;
}

@Injectable()
export class LandingResourcesService {
  constructor(
    private readonly meta:    MetaAccountsRepository,
    private readonly tiktok:  TikTokAccountsRepository,
    private readonly tracked: TrackedChannelsConfigRepository,
  ) {}

  async listPublic(): Promise<LandingResource[]> {
    const [metaRows, tiktokRows, trackedRows] = await Promise.all([
      this.meta.listFeatured(),
      this.tiktok.listFeatured(),
      this.tracked.listFeatured(),
    ]);

    const telegram: LandingResource[] = trackedRows.map((row) => {
      const handle = stripAt(row.channel_key ?? row.username);
      return {
        platform: 'telegram',
        handle,
        displayName: row.title,
        avatarUrl: null,
        followerCount: row.subs_count,
        url: landingUrl('telegram', handle),
        order: row.landing_order,
      };
    });

    const metaResources: LandingResource[] = metaRows.map((row) => ({
      platform: row.platform,
      handle: row.username,
      displayName: row.display_name,
      avatarUrl: row.picture_url,
      followerCount: row.followers,
      url: landingUrl(row.platform, row.username),
      order: row.landing_order,
    }));

    const tiktokResources: LandingResource[] = tiktokRows.map((row) => ({
      platform: 'tiktok',
      handle: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      followerCount: null,
      url: landingUrl('tiktok', row.username),
      order: row.landing_order,
    }));

    return [...telegram, ...metaResources, ...tiktokResources].sort((a, b) => a.order - b.order);
  }
}
