// Global platform filter, persisted in the URL (?platform=). Only Telegram
// has data today; the others are reserved for future integrations.
import { useNavigate, useSearch } from '@tanstack/react-router';

export const PLATFORMS = ['all', 'telegram', 'instagram', 'tiktok', 'threads', 'facebook'] as const;
export type Platform = typeof PLATFORMS[number];

/** Platforms that actually have data / are selectable right now. */
export const ACTIVE_PLATFORMS: Platform[] = ['all', 'telegram'];

export function parsePlatform(raw: unknown): Platform {
  return PLATFORMS.includes(raw as Platform) ? (raw as Platform) : 'all';
}

export function usePlatform(): [Platform, (p: Platform) => void] {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const platform = parsePlatform(search.platform);
  const setPlatform = (p: Platform) =>
    navigate({ to: '.', search: (prev: Record<string, unknown>) => ({ ...prev, platform: p === 'all' ? undefined : p }) } as any);
  return [platform, setPlatform];
}
