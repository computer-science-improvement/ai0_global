import type { ReactNode } from 'react';
import { Crumbs, type Crumb } from './Crumbs';

export function PageHeader({ title, subtitle, actions, crumbs }: {
  title: string; subtitle?: string; actions?: ReactNode;
  /** Spec 027 FR-013: ancestors of this page, built with `useCrumbs()`. */
  crumbs?: Crumb[];
}) {
  return (
    <>
      {crumbs && crumbs.length > 0 && <Crumbs crumbs={crumbs} />}
      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 24 }}>
        <div>
          <h1 className="text-display-md" style={{ margin: 0, fontSize: 24, fontWeight: 500, letterSpacing: '-0.03em' }}>{title}</h1>
          {subtitle && <p className="text-caption" style={{ margin: '6px 0 0', color: 'var(--color-ink-muted)' }}>{subtitle}</p>}
        </div>
        {actions && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{actions}</div>}
      </header>
    </>
  );
}
