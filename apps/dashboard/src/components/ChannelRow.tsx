import { Link } from '@tanstack/react-router';
import { fmtNumber, fmtRelative } from '../lib/format';
import type { TrackedChannel } from '../api/types';

export function ChannelRow({ c }: { c: TrackedChannel }) {
  const strategies = c.strategies ?? [];
  return (
    <Link
      to={'/channels/$id' as any}
      params={{ id: c.id } as any}
      style={{
        display: 'block',
        background: 'var(--color-surface-1)',
        borderRadius: 'var(--radius-lg)',
        padding: '14px 18px',
        textDecoration: 'none',
        color: 'inherit',
        transition: 'background 0.12s ease',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-2)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-1)'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="text-body" style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
              {c.title ?? c.username ?? '(no title)'}
            </span>
            {c.isMine   && <span className="chip chip-success">mine</span>}
            {c.isClosed && <span className="chip">closed</span>}
          </div>
          {c.username && (
            <div className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>
              @{c.username}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 18 }}>
          <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontVariantNumeric: 'tabular-nums' }}>
            {fmtNumber(c.subsCount)}
          </span>
          <PollTierChip tier={c.pollTier} />
          <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>{fmtRelative(c.lastPolledAt)}</span>
        </div>
      </div>

      {strategies.length > 0 && (
        <div style={{
          marginTop: 10, paddingTop: 10,
          borderTop: '1px solid var(--color-hairline-soft)',
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>strategies:</span>
          {strategies.map(s => (
            <span
              key={s.id}
              className={s.enabled ? 'chip is-active' : 'chip'}
              title={`${s.ext_id} · ${s.role}${s.enabled ? '' : ' · paused'}`}
              style={{ opacity: s.enabled ? 1 : 0.6 }}
            >
              {s.type}
              {s.role === 'forward' && <span style={{ marginLeft: 4, color: 'var(--color-ink-dim)' }}>↩</span>}
            </span>
          ))}
        </div>
      )}
    </Link>
  );
}

function PollTierChip({ tier }: { tier: TrackedChannel['pollTier'] }) {
  const cls = tier === 'hot' ? 'chip chip-warning' : tier === 'warm' ? 'chip chip-success' : 'chip';
  return <span className={cls}>{tier}</span>;
}
