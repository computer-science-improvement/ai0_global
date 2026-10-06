import { Link, useRouterState } from '@tanstack/react-router';
import { Icon } from './ui/Icon';

/**
 * Spec 027 FR-002: the not-found page for any unknown path under /app. It renders
 * inside the app shell (sidebar and header stay), so the menu is still one click
 * away; ⌘K opens the command palette.
 */
export function AppNotFound() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 0' }}>
      <div className="card-featured" style={{ maxWidth: 440, width: '100%', padding: 32, textAlign: 'center' }}>
        <span className="section-glyph" style={{ margin: '0 auto 14px', display: 'inline-flex' }}><Icon name="ban" size={16} /></span>
        <h1 className="text-display-md" style={{ margin: '0 0 8px', fontSize: 22, fontWeight: 500 }}>Page not found</h1>
        <p className="text-body-sm" style={{ margin: '0 0 20px', color: 'var(--color-ink-muted)', wordBreak: 'break-all' }}>
          Nothing lives at <code>{path}</code>. It may have moved or been removed.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link to="/app" className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="overview" size={14} /> Go to Overview
          </Link>
        </div>
        <p className="text-micro" style={{ margin: '16px 0 0', color: 'var(--color-ink-dim)' }}>
          Press <kbd className="kbd">{isMac ? '⌘' : 'Ctrl'} K</kbd> to jump to any page.
        </p>
      </div>
    </div>
  );
}
