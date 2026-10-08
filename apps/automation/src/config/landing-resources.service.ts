// apps/automation/src/config/landing-resources.service.ts
import { Injectable, Optional } from '@nestjs/common';
import { MetaAccountsRepository } from './meta-accounts.repository';
import { TikTokAccountsRepository } from './tiktok-accounts.repository';
import { TrackedChannelsConfigRepository } from './tracked-channels.repository';
import { YoutubeLandingRepository, type YoutubeLandingRow } from './youtube-landing.repository';

export type LandingPlatform = 'telegram' | 'instagram' | 'facebook' | 'threads' | 'tiktok' | 'youtube';

/** Every landing platform, in display order. */
export const LANDING_PLATFORMS: readonly LandingPlatform[] = ['telegram', 'instagram', 'facebook', 'threads', 'tiktok', 'youtube'];

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

/**
 * A featured resource plus the internal keys the network view (spec 026 FR-006) needs
 * to find its network and agent. Server-side only: `ref` and `channelKey` never leave
 * the API (the networks payload maps them away).
 */
export interface LandingFeaturedEntry {
  /** ResourceCatalog ref: `telegram:<channel_key>`, `<meta platform>:<id>`, `tiktok:<id>`, `youtube:<id>`. */
  ref:        string | null;
  /** Telegram channel key as stored (e.g. `@my_channel`), for ad prices; null on other platforms. */
  channelKey: string | null;
  resource:   LandingResource;
}

/** Pure, unit-testable: derive a public profile url from a handle. */
export function landingUrl(platform: LandingPlatform, handle: string | null): string | null {
  if (handle === null) return null;
  switch (platform) {
    case 'youtube':   return `https://www.youtube.com/@${handle}`;
    case 'telegram':  return `https://t.me/${handle}`;
    case 'instagram': return `https://www.instagram.com/${handle}`;
    case 'facebook':  return `https://www.facebook.com/${handle}`;
    case 'threads':   return `https://www.threads.net/@${handle}`;
    case 'tiktok':    return `https://www.tiktok.com/@${handle}`;
  }
}

/** FR-010: `youtube.com/@<handle>`, else `youtube.com/channel/<channel_id>`. */
export function youtubeUrl(handle: string | null, channelId: string | null): string | null {
  if (handle) return landingUrl('youtube', handle);
  return channelId ? `https://www.youtube.com/channel/${encodeURIComponent(channelId)}` : null;
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
    // Optional so the unit tests that predate YouTube keep constructing the service with three repos.
    @Optional() private readonly youtube?: YoutubeLandingRepository,
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

  /** Map a youtube row to the public projection (FR-010; `subscribers` stays null until 019b fills it). */
  private mapYoutube(row: YoutubeLandingRow): LandingResource {
    const handle = stripAt(row.handle);
    return {
      platform: 'youtube',
      handle,
      displayName: row.title,
      avatarUrl: null,
      followerCount: row.subscribers == null ? null : Number(row.subscribers),
      url: youtubeUrl(handle, row.channel_id),
      order: row.landing_order,
    };
  }

  /** Featured (and active) resources with their internal keys, ordered like listPublic. */
  async listFeaturedEntries(): Promise<LandingFeaturedEntry[]> {
    const [metaRows, tiktokRows, trackedRows, youtubeRows] = await Promise.all([
      this.meta.listFeatured(),
      this.tiktok.listFeatured(),
      this.tracked.listFeatured(),
      this.youtube ? this.youtube.listFeatured() : Promise.resolve([] as YoutubeLandingRow[]),
    ]);
    const entries: LandingFeaturedEntry[] = [
      ...trackedRows.map((row) => ({
        ref: row.channel_key ? `telegram:${row.channel_key}` : null, channelKey: row.channel_key, resource: this.mapTracked(row),
      })),
      ...metaRows.map((row) => ({ ref: row.id ? `${row.platform}:${row.id}` : null, channelKey: null, resource: this.mapMeta(row) })),
      ...tiktokRows.map((row) => ({ ref: row.id ? `tiktok:${row.id}` : null, channelKey: null, resource: this.mapTiktok(row) })),
      ...youtubeRows.map((row) => ({ ref: `youtube:${row.id}`, channelKey: null, resource: this.mapYoutube(row) })),
    ];
    return entries.sort((a, b) => a.resource.order - b.resource.order);
  }

  async listPublic(): Promise<LandingResource[]> {
    return (await this.listFeaturedEntries()).map((e) => e.resource);
  }

  /** Operator-facing list: every ACTIVE candidate (visible or not; inactive accounts are hidden,
   *  BR-MKT-01), with id + landingVisible. Same normalization as listPublic. NEVER emits tokens. */
  async listAdmin(): Promise<LandingAdminResource[]> {
    const [trackedRows, allMeta, allTiktok, youtubeRows] = await Promise.all([
      this.tracked.listLandingCandidates(),
      this.meta.list(),
      this.tiktok.list(),
      this.youtube ? this.youtube.listCandidates() : Promise.resolve([] as YoutubeLandingRow[]),
    ]);
    const metaRows = allMeta.filter((row) => row.active !== false);
    const tiktokRows = allTiktok.filter((row) => row.active !== false);

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

    const youtubeResources = youtubeRows.map((row) => ({
      ...this.mapYoutube(row),
      id: row.id,
      landingVisible: row.landing_visible,
    }));

    return [...telegram, ...metaResources, ...tiktokResources, ...youtubeResources]
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
      case 'youtube':
        if (!this.youtube) throw new Error('YouTube landing is not available');
        return this.youtube.setLanding(id, { visible: opts.visible, order: opts.order });
      default:
        throw new Error(`Unknown landing platform: ${platform as string}`);
    }
  }
}
