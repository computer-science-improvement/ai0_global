import { Link, useRouterState } from '@tanstack/react-router';
import { Icon } from './ui/Icon';
import './auth/auth.css';

/**
 * Spec 027 FR-002: the not-found page for any unknown path under /app. It renders
 * inside the app shell (sidebar and header stay), so the menu is still one click
 * away; ⌘K opens the command palette.
 */
export function AppNotFound() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return (
    <div className="au-nf">
      <div className="panel is-section au-nf-card compose-rise">
        <span className="section-glyph"><Icon name="ban" size={16} /></span>
        <div className="text-overline" style={{ marginBottom: 8 }}>404</div>
        <h1 className="page-title au-nf-title">Page not found</h1>
        <p className="text-body-sm au-nf-text">
          Nothing lives at <code className="mono">{path}</code>. It may have moved or been removed.
        </p>
        <div className="au-nf-actions">
          <Link to="/app" className="btn-primary">
            <Icon name="overview" size={14} /> Go to Today
          </Link>
        </div>
        <p className="au-nf-hint">
          Press <kbd className="kbd">{isMac ? '⌘' : 'Ctrl'} K</kbd> to jump to any page.
        </p>
      </div>
    </div>
  );
}
