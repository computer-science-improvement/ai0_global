import type { ReactNode } from 'react';

export function PageHeader({ title, subtitle, actions }: {
  title: string; subtitle?: string; actions?: ReactNode;
}) {
  return (
    <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
      <div>
        <h1 className="text-display-md" style={{ margin: 0, fontSize: 24, fontWeight: 500, letterSpacing: '-0.03em' }}>{title}</h1>
        {subtitle && <p className="text-caption" style={{ margin: '6px 0 0', color: 'var(--color-ink-muted)' }}>{subtitle}</p>}
      </div>
      {actions && <div style={{ display: 'flex', gap: 8 }}>{actions}</div>}
    </header>
  );
}
