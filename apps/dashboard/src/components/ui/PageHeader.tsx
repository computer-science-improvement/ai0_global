import type { ReactNode } from 'react';
import { Crumbs, type Crumb } from './Crumbs';

/**
 * The header of every page: optional crumbs, an optional mono eyebrow, the title (32px, `.page-title`), a one-line
 * subtitle and the page's actions on the right (primary action last).
 */
export function PageHeader({ title, subtitle, eyebrow, actions, crumbs }: {
  title: ReactNode;
  /** One line under the title (15px, muted). */
  subtitle?: ReactNode;
  /** Mono overline above the title: the date and place, or the parent context ("WED, 28 OCT · KYIV 21:51"). */
  eyebrow?: ReactNode;
  actions?: ReactNode;
  /** Spec 027 FR-013: ancestors of this page, built with `useCrumbs()`. */
  crumbs?: Crumb[];
}) {
  return (
    <>
      {crumbs && crumbs.length > 0 && <Crumbs crumbs={crumbs} />}
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 24 }}>
        <div style={{ minWidth: 0 }}>
          {eyebrow && <div className="text-overline" style={{ marginBottom: 8 }}>{eyebrow}</div>}
          <h1 className="page-title" style={{ margin: 0 }}>{title}</h1>
          {subtitle && <p className="text-body" style={{ margin: '6px 0 0', color: 'var(--color-ink-muted)' }}>{subtitle}</p>}
        </div>
        {actions && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{actions}</div>}
      </header>
    </>
  );
}
