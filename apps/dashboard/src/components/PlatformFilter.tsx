import { SegmentedTabs } from './SegmentedTabs';
import type { IconName } from './ui/Icon';
import { usePlatform, ACTIVE_PLATFORMS, type Platform } from '../lib/usePlatform';

const META: Record<Platform, { label: string; icon?: IconName }> = {
  all:       { label: 'All' },
  telegram:  { label: 'Telegram', icon: 'telegram' },
  meta:      { label: 'Meta',     icon: 'facebook' },
  tiktok:    { label: 'TikTok',   icon: 'tiktok' },
};
const ORDER: Platform[] = ['all', 'telegram', 'meta', 'tiktok'];

/** Global publish-platform filter (Strategies). Renders the shared
 *  SegmentedTabs — the same control every other page uses — with the
 *  not-yet-active platforms disabled ("soon"). */
export function PlatformFilter() {
  const [platform, setPlatform] = usePlatform();
  const options = ORDER.map((p) => ({
    key: p,
    label: META[p].label,
    icon: META[p].icon,
    disabled: !ACTIVE_PLATFORMS.includes(p),
  }));
  return <SegmentedTabs value={platform} onChange={setPlatform} options={options} />;
}
