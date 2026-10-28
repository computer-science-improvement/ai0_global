// Shared parts of the Connections managers (spec 078 C2): a flush panel with a note and an Add button in its head, the
// loading / error lines, and one connection row (glyph, identity, numbers, actions). Styles in connections.css.

import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { SectionCard } from '../ui/primitives';
import { Icon, type IconName } from '../ui/Icon';
import { describeError } from '../ui/Toast';
import './connections.css';

/** One manager's panel: title and the Add button in the head, a one-line note under it, then the rows. */
export function ConnPanel({ title, icon, note, add, delay = 0, children }: {
  title: string;
  icon?: IconName;
  note?: ReactNode;
  /** The panel's one main action (`<ConnAdd>`). */
  add?: ReactNode;
  delay?: number;
  children: ReactNode;
}) {
  return (
    <SectionCard title={title} icon={icon} flush delay={delay} action={add}>
      {note && <p className="conn-note">{note}</p>}
      {children}
    </SectionCard>
  );
}

/** "Add bot": a small primary button for a panel head. */
export function ConnAdd({ onClick, disabled, icon = 'plus', children }: {
  onClick: () => void; disabled?: boolean; icon?: IconName; children: ReactNode;
}) {
  return (
    <button type="button" className="btn-primary btn-sm" onClick={onClick} disabled={disabled}>
      <Icon name={icon} size={14} /> {children}
    </button>
  );
}

/** The loading line and the load error of a list (a failed endpoint leaves the panel readable, with the reason). */
export function ConnState({ loading, error }: { loading?: boolean; error?: unknown }) {
  return (
    <>
      {loading && <p className="conn-state" role="status">Loading…</p>}
      {error != null && <div className="conn-pad"><div className="callout-danger" role="alert">{describeError(error)}</div></div>}
    </>
  );
}

/** A mutation error under the head of the list (set default, delete...). */
export function ConnError({ error }: { error: unknown }) {
  return error == null ? null : <p className="conn-error" role="alert">{describeError(error)}</p>;
}

/** Where the identity block of a row leads (Meta accounts open their page). */
export interface ConnLink { to: string; params?: Record<string, string> }

/**
 * One connection as a row of a flush panel: a 36px glyph, the identity (`children`: `.conn-title` and `.conn-sub` lines),
 * optional numbers (`stat`) and the row's actions on the right. `onOpen` makes the whole row clickable (bots open their
 * channels); `link` makes only the identity a link. The actions stop the click from reaching the row.
 */
export function ConnRow({ lead, children, stat, actions, onOpen, link, title }: {
  lead: ReactNode;
  children: ReactNode;
  stat?: ReactNode;
  actions?: ReactNode;
  onOpen?: () => void;
  link?: ConnLink;
  title?: string;
}) {
  const ident = (
    <>
      <span className="conn-lead" aria-hidden>{lead}</span>
      <div className="conn-main">{children}</div>
    </>
  );
  return (
    <div className={`panel-row conn-row${onOpen ? ' is-link' : ''}`} onClick={onOpen} title={title}>
      {link
        ? <Link to={link.to as any} params={link.params as any} className="conn-ident">{ident}</Link>
        : <div className="conn-ident">{ident}</div>}
      {stat}
      {actions && <div className="conn-actions" onClick={(e) => e.stopPropagation()}>{actions}</div>}
    </div>
  );
}

/** A number on the right of a row: value over a small label (and an optional toned delta). */
export function ConnStat({ value, label, delta, tone }: { value: ReactNode; label: string; delta?: ReactNode; tone?: 'up' | 'down' }) {
  return (
    <div className="conn-stat">
      <div className="conn-stat-value">{value}</div>
      <div className="conn-stat-label">{label}</div>
      {delta != null && <div className={`conn-stat-delta${tone ? ` is-${tone}` : ''}`}>{delta}</div>}
    </div>
  );
}
