import { Link } from '@tanstack/react-router';
import { fmtNumber, fmtRelative } from '../lib/format';
import type { TrackedChannel } from '../api/types';

const TIER_STYLE: Record<TrackedChannel['pollTier'], { bg: string; text: string }> = {
  hot:  { bg: 'rgba(255, 122, 61, 0.16)',  text: 'var(--color-grad-orange)' },
  warm: { bg: 'rgba(245, 158, 11, 0.16)',  text: 'var(--color-warning)' },
  cold: { bg: 'rgba(0, 153, 255, 0.16)',   text: 'var(--color-accent)' },
};

export function ChannelRow({ c }: { c: TrackedChannel }) {
  const tier = TIER_STYLE[c.pollTier];
  return (
    <Link to={'/channels/$id' as any} params={{ id: c.id } as any}
      className="flex items-center justify-between transition-colors"
      style={{
        background: 'var(--color-surface-1)',
        borderRadius: 'var(--radius-lg)',
        padding: '14px 18px',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-2)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-1)'; }}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-medium tracking-[-0.18px]" style={{ color: 'var(--color-ink)' }}>
            {c.title ?? c.username ?? '(no title)'}
          </span>
          {c.isMine && (
            <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: 'var(--color-surface-2)', color: 'var(--color-success)' }}>
              mine
            </span>
          )}
          {c.isClosed && (
            <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: 'var(--color-surface-2)', color: 'var(--color-ink-muted)' }}>
              closed
            </span>
          )}
        </div>
        {c.username && (
          <div className="text-[12px] tracking-[-0.12px]" style={{ color: 'var(--color-ink-muted)' }}>
            @{c.username}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-5 text-[13px]">
        <span className="tabular-nums" style={{ color: 'var(--color-ink)' }}>{fmtNumber(c.subsCount)}</span>
        <span className="rounded-full px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider"
              style={{ background: tier.bg, color: tier.text }}>
          {c.pollTier}
        </span>
        <span style={{ color: 'var(--color-ink-muted)' }}>{fmtRelative(c.lastPolledAt)}</span>
      </div>
    </Link>
  );
}
