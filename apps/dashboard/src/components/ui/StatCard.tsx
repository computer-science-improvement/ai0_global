import type { ReactNode } from 'react';

export function StatCard({ label, value, delta, deltaTone = 'neutral' }: {
  label: string; value: ReactNode;
  delta?: string; deltaTone?: 'up' | 'down' | 'neutral';
}) {
  const color = deltaTone === 'up' ? 'var(--color-success)'
    : deltaTone === 'down' ? 'var(--color-danger)'
    : 'var(--color-ink-muted)';
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontSize: 11, color: 'var(--color-ink-muted)' }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em', marginTop: 6 }}>{value}</div>
      {delta && <div style={{ fontSize: 11, marginTop: 4, color }}>{delta}</div>}
    </div>
  );
}
