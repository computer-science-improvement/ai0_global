import type { ReactNode } from 'react';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

const STYLE: Record<Tone, { bg: string; fg: string }> = {
  neutral: { bg: 'var(--color-surface-3)',   fg: 'var(--color-ink-muted)' },
  success: { bg: 'var(--color-success-soft)', fg: 'var(--color-success)' },
  warning: { bg: 'var(--color-warning-soft)', fg: 'var(--color-warning)' },
  danger:  { bg: 'var(--color-danger-soft)',  fg: 'var(--color-danger)' },
  accent:  { bg: 'var(--color-accent)',       fg: 'var(--color-on-accent)' },
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  const s = STYLE[tone];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: s.bg, color: s.fg,
      fontSize: 10, fontWeight: 500, padding: '2px 8px',
      borderRadius: 'var(--radius-pill)', lineHeight: 1.6,
    }}>{children}</span>
  );
}
