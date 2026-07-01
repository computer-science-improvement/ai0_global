// Shared "patch-bay" UI primitives — the Groups-page visual language, packaged
// so every page is built from the SAME parts and reads consistently. Backed by
// the .panel / .hub-glyph / .stat-tile / .section-head / .status-dot /
// .empty-state classes in index.css.

import type { ReactNode, CSSProperties } from 'react';
import { Icon, type IconName } from './Icon';

export type Tone = 'success' | 'warning' | 'danger' | 'accent' | 'neutral';

const TONE_VAR: Record<Tone, string> = {
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  danger:  'var(--color-danger)',
  accent:  'var(--color-accent)',
  neutral: 'var(--color-ink-dim)',
};

/** A labelled form field for dialogs/forms — eyebrow label + optional hint,
 *  consistent spacing. Pair with `.input-field` controls. */
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

/** A green-tinted hub node holding a brand initial or an icon. */
export function HubGlyph({ children, size = 38 }: { children: ReactNode; size?: number }) {
  return (
    <div className="hub-glyph" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden>
      {children}
    </div>
  );
}

/** A status dot with a soft halo. Tone drives the colour. */
export function StatusDot({ tone = 'neutral', size = 8 }: { tone?: Tone; size?: number }) {
  return (
    <span
      className="status-dot"
      style={{ width: size, height: size, ['--dot' as string]: TONE_VAR[tone] } as CSSProperties}
    />
  );
}

/** KPI tile: label, big number, optional +/- delta and leading icon. */
export function StatTile({ label, value, delta, deltaTone = 'neutral', icon, accent = false, style }: {
  label: string;
  value: ReactNode;
  delta?: ReactNode;
  deltaTone?: Tone;
  icon?: IconName;
  accent?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div className={`stat-tile${accent ? ' is-accent' : ''}`} style={style}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        {icon && (
          <span style={{
            display: 'inline-flex', padding: 7, borderRadius: 'var(--radius-sm)',
            background: accent ? 'rgba(62,207,142,0.16)' : 'var(--color-surface-3)',
            color: accent ? 'var(--color-accent)' : 'var(--color-ink-muted)',
          }}>
            <Icon name={icon} size={14} />
          </span>
        )}
        <span className="text-micro" style={{ color: 'var(--color-ink-dim)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {label}
        </span>
      </div>
      <div className="tabular-nums" style={{ fontSize: 27, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--color-ink)', lineHeight: 1.1 }}>
        {value}
      </div>
      {delta != null && (
        <div className="text-micro" style={{ marginTop: 6, color: TONE_VAR[deltaTone], fontWeight: 500 }}>
          {delta}
        </div>
      )}
    </div>
  );
}

/** Elevated section card with a tinted glyph + title header. */
export function SectionCard({ title, icon, action, children, style, delay, interactive = false }: {
  title: ReactNode;
  icon?: IconName;
  action?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
  /** ms entrance delay (pairs with className compose-rise) */
  delay?: number;
  interactive?: boolean;
}) {
  return (
    <section
      className={`panel${interactive ? ' is-interactive' : ''}${delay != null ? ' compose-rise' : ''}`}
      style={{ ...(delay != null ? { animationDelay: `${delay}ms` } : null), ...style }}
    >
      <div className="section-head">
        {icon && <span className="section-glyph"><Icon name={icon} size={15} /></span>}
        <h2 className="text-heading-md" style={{ margin: 0, fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--color-ink)' }}>
          {title}
        </h2>
        {action && <div style={{ marginLeft: 'auto' }}>{action}</div>}
      </div>
      {children}
    </section>
  );
}

/** Crafted empty/zero state — dashed medallion, title, note, optional action. */
export function EmptyState({ icon, title, note, action }: {
  icon: IconName;
  title: string;
  note?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-medallion"><Icon name={icon} size={20} /></div>
      <p className="text-body" style={{ color: 'var(--color-ink)', margin: '0 0 4px', fontWeight: 500 }}>{title}</p>
      {note && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0, maxWidth: 460, marginInline: 'auto' }}>{note}</p>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}
