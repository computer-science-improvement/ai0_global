// Shared panel primitives — the building blocks every page is made of, so every page reads the same. Backed by the
// .panel / .hub-glyph / .stat-tile / .stat-strip / .section-head / .status-dot / .empty-state classes in index.css.
// See "Design language" in apps/dashboard/CLAUDE.md for which one to use when.

import type { ReactNode, CSSProperties } from 'react';
import { Icon, type IconName } from './Icon';
import { Sparkline } from './Sparkline';

export type Tone = 'success' | 'warning' | 'danger' | 'accent' | 'neutral';

const TONE_VAR: Record<Tone, string> = {
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  danger:  'var(--color-danger)',
  accent:  'var(--color-accent)',
  neutral: 'var(--color-ink-dim)',
};

/** A labelled form field for dialogs/forms — label + optional hint, consistent spacing. Pair with `.input-field` controls. */
export function Field({ label, hint, children, style }: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div style={{ marginBottom: 16, ...style }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span className="text-eyebrow">{label}</span>
        {hint && <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** A tinted hub node holding a brand initial or an icon. `tone="neutral"` for things that are not agents. */
export function HubGlyph({ children, size = 38, tone = 'accent' }: { children: ReactNode; size?: number; tone?: 'accent' | 'neutral' }) {
  return (
    <div className={`hub-glyph${tone === 'neutral' ? ' is-neutral' : ''}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden>
      {children}
    </div>
  );
}

/** A status dot with a soft halo. Tone drives the colour. For a status that must read by shape use `StatusMark`. */
export function StatusDot({ tone = 'neutral', size = 8 }: { tone?: Tone; size?: number }) {
  return (
    <span
      className="status-dot"
      style={{ width: size, height: size, ['--dot' as string]: TONE_VAR[tone] } as CSSProperties}
    />
  );
}

/**
 * KPI tile: a sentence-case label, a 28px value, an optional delta (mono, toned) and an optional sparkline.
 * One tile alone is a card; several belong in a `<StatStrip>`.
 */
export function StatTile({ label, value, delta, deltaTone = 'neutral', icon, accent = false, spark, style }: {
  label: string;
  value: ReactNode;
  /** A small line under the value: "+12 vs yesterday". Coloured by `deltaTone`. */
  delta?: ReactNode;
  deltaTone?: Tone;
  icon?: IconName;
  /** Tints the tile green: the one number the page is about. */
  accent?: boolean;
  /** Last N values, oldest first: draws a `Sparkline` under the value. */
  spark?: number[];
  style?: CSSProperties;
}) {
  return (
    <div className={`stat-tile${accent ? ' is-accent' : ''}`} style={style}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        {icon && (
          <span style={{
            display: 'inline-flex', padding: 7, borderRadius: 'var(--radius-sm)',
            background: accent ? 'color-mix(in srgb, var(--color-accent) 16%, transparent)' : 'var(--color-surface-3)',
            color: accent ? 'var(--color-accent)' : 'var(--color-ink-muted)',
          }}>
            <Icon name={icon} size={14} />
          </span>
        )}
        <span className="stat-label">{label}</span>
      </div>
      <div className="stat-value">{value}</div>
      {delta != null && <div className="stat-delta" style={{ color: TONE_VAR[deltaTone] }}>{delta}</div>}
      {spark && spark.length > 0 && <div style={{ marginTop: 12 }}><Sparkline values={spark} /></div>}
    </div>
  );
}

/** KPI strip: several `StatTile`s in ONE panel, split by hairlines (instead of a grid of separate cards). */
export function StatStrip({ children, label, style }: {
  children: ReactNode;
  /** Accessible name of the group ("Key numbers"). */
  label?: string;
  style?: CSSProperties;
}) {
  return <div className="stat-strip" role="group" aria-label={label} style={style}>{children}</div>;
}

/**
 * The page's panel: a title (with an optional glyph and a right-hand `action`) over its content.
 *  - default: content is padded inside the panel.
 *  - `flush`: no padding; children are full-bleed rows (`<div className="panel-row">`, optional `.panel-foot`). A list of
 *    entities is rows in a flush panel. A text-link `action` ("Open inbox · 17 →") takes `className="panel-link"`.
 */
export function SectionCard({ title, icon, action, children, style, delay, interactive = false, flush = false }: {
  title: ReactNode;
  icon?: IconName;
  action?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
  /** ms entrance delay (pairs with className compose-rise) */
  delay?: number;
  interactive?: boolean;
  /** Rows instead of padded content (see above). */
  flush?: boolean;
}) {
  return (
    <section
      className={`panel is-section${flush ? ' is-flush' : ''}${interactive ? ' is-interactive' : ''}${delay != null ? ' compose-rise' : ''}`}
      style={{ ...(delay != null ? { animationDelay: `${delay}ms` } : null), ...style }}
    >
      <div className={flush ? 'panel-head' : 'section-head'}>
        {icon && <span className="section-glyph"><Icon name={icon} size={15} /></span>}
        <h2 className="text-heading-md" style={{ margin: 0, color: 'var(--color-ink)' }}>
          {title}
        </h2>
        {action && <div style={{ marginLeft: 'auto' }}>{action}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * Crafted empty/zero state — medallion, title, note, optional action. Inside a panel it drops its dashed frame.
 * `tone="clear"` is the good kind of empty ("All clear", "Nothing to approve"): a green medallion with a check.
 */
export function EmptyState({ icon, title, note, action, tone = 'neutral' }: {
  /** Defaults to a check for `clear`, an inbox otherwise. */
  icon?: IconName;
  title: string;
  note?: ReactNode;
  action?: ReactNode;
  tone?: 'neutral' | 'clear';
}) {
  return (
    <div className={`empty-state${tone === 'clear' ? ' is-clear' : ''}`}>
      <div className="empty-medallion"><Icon name={icon ?? (tone === 'clear' ? 'check' : 'inbox')} size={20} /></div>
      <p className="empty-title">{title}</p>
      {note && <p className="empty-note">{note}</p>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}
