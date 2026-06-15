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

/** Operator-facing projection: the public fields PLUS row id + visibility flag. */
export interface LandingAdminResource extends LandingResource {
  id: string;
  landingVisible: boolean;
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

  // ---- shared per-row normalization (single source of truth for listPublic + listAdmin) ----

  /** Map a tracked-channel row (telegram) to the public projection. */
  private mapTracked(row: { channel_key: string | null; username: string | null; title: string | null; subs_count: number | null; landing_order: number }): LandingResource {
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
  }

  /** Map a meta row (instagram/facebook/threads) to the public projection. */
  private mapMeta(row: { platform: LandingPlatform; username: string | null; display_name: string | null; followers: number | null; picture_url: string | null; landing_order: number }): LandingResource {
    return {
      platform: row.platform,
      handle: row.username,
      displayName: row.display_name,
      avatarUrl: row.picture_url,
      followerCount: row.followers,
      url: landingUrl(row.platform, row.username),
      order: row.landing_order,
    };
  }

  /** Map a tiktok row to the public projection (never touches token fields). */
  private mapTiktok(row: { username: string | null; display_name: string | null; avatar_url: string | null; landing_order: number }): LandingResource {
    return {
      platform: 'tiktok',
      handle: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      followerCount: null,
      url: landingUrl('tiktok', row.username),
      order: row.landing_order,
    };
  }

  async listPublic(): Promise<LandingResource[]> {
    const [metaRows, tiktokRows, trackedRows] = await Promise.all([
      this.meta.listFeatured(),
      this.tiktok.listFeatured(),
      this.tracked.listFeatured(),
    ]);

    const telegram = trackedRows.map((row) => this.mapTracked(row));
    const metaResources = metaRows.map((row) => this.mapMeta(row));
    const tiktokResources = tiktokRows.map((row) => this.mapTiktok(row));

    return [...telegram, ...metaResources, ...tiktokResources].sort((a, b) => a.order - b.order);
  }

  /** Operator-facing list: ALL candidates across the 3 tables (visible or not),
   *  with id + landingVisible. Same normalization as listPublic. NEVER emits tokens. */
  async listAdmin(): Promise<LandingAdminResource[]> {
    const [trackedRows, metaRows, tiktokRows] = await Promise.all([
      this.tracked.listLandingCandidates(),
      this.meta.list(),
      this.tiktok.list(),
    ]);

    const telegram = trackedRows.map((row) => ({
      ...this.mapTracked(row),
      id: row.id,
      landingVisible: row.landing_visible,
    }));

    const metaResources = metaRows.map((row) => ({
      ...this.mapMeta(row),
      id: row.id,
      landingVisible: row.landing_visible,
    }));

    const tiktokResources = tiktokRows.map((row) => ({
      ...this.mapTiktok(row),
      id: row.id,
      landingVisible: row.landing_visible,
    }));

    return [...telegram, ...metaResources, ...tiktokResources]
      .sort((a, b) => a.order - b.order || a.platform.localeCompare(b.platform));
  }

  /** Toggle a single candidate's visibility/order, routing by platform. */
  async setFeatured(platform: LandingPlatform, id: string, opts: { visible: boolean; order: number }): Promise<void> {
    switch (platform) {
      case 'telegram':
        return this.tracked.setLanding(id, { visible: opts.visible, order: opts.order });
      case 'instagram':
      case 'facebook':
      case 'threads':
        return this.meta.setLanding(id, { visible: opts.visible, order: opts.order });
      case 'tiktok':
        return this.tiktok.setLanding(id, { visible: opts.visible, order: opts.order });
      default:
        throw new Error(`Unknown landing platform: ${platform as string}`);
    }
  }
}
