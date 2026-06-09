import { Icon, type IconName } from './ui/Icon';
import { usePlatform, ACTIVE_PLATFORMS, type Platform } from '../lib/usePlatform';

const META: Record<Platform, { label: string; icon?: IconName }> = {
  all:       { label: 'All' },
  telegram:  { label: 'Telegram', icon: 'telegram' },
  meta:      { label: 'Meta',     icon: 'facebook' },
  tiktok:    { label: 'TikTok',   icon: 'tiktok' },
};
const ORDER: Platform[] = ['all', 'telegram', 'meta', 'tiktok'];

export function PlatformFilter() {
  const [platform, setPlatform] = usePlatform();
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {ORDER.map(p => {
        const active = platform === p;
        const enabled = ACTIVE_PLATFORMS.includes(p);
        const meta = META[p];
        return (
          <button
            key={p}
            disabled={!enabled}
            onClick={() => enabled && setPlatform(p)}
            title={enabled ? meta.label : `${meta.label} — soon`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontSize: 12, padding: '5px 11px', borderRadius: 'var(--radius-sm)',
              border: `1px solid ${active ? 'rgba(62,207,142,0.3)' : 'transparent'}`,
              background: active ? 'var(--color-success-soft)' : 'transparent',
              color: active ? 'var(--color-accent)' : enabled ? 'var(--color-ink-muted)' : 'var(--color-ink-dim)',
              cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.6,
            }}
          >
            {meta.icon && <Icon name={meta.icon} size={13} />}
            {meta.label}
          </button>
        );
      })}
    </div>
  );
}
