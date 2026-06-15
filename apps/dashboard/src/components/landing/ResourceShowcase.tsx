import type { CSSProperties, JSX } from 'react';
import type { LandingPlatform, LandingResource } from '../../api/landing';
import { Icon, type IconName } from '../ui/Icon';

// ── Platform metadata ──────────────────────────────────────────────────────
// Each platform maps to its Icon glyph, a human label, and a brand-ish accent
// used ONLY as a faint glow/tint so the grid reads as "one network, many
// surfaces" without abandoning the emerald-on-dark system.
const PLATFORM: Record<LandingPlatform, { icon: IconName; label: string; tint: string }> = {
  telegram:  { icon: 'telegram',  label: 'Telegram',  tint: '#2aabee' },
  instagram: { icon: 'instagram', label: 'Instagram', tint: '#e1306c' },
  facebook:  { icon: 'facebook',  label: 'Facebook',  tint: '#1877f2' },
  threads:   { icon: 'threads',   label: 'Threads',   tint: '#ededed' },
  tiktok:    { icon: 'tiktok',    label: 'TikTok',    tint: '#25f4ee' },
};

/** 12_345 → "12.3K", 1_200_000 → "1.2M". Trims a trailing ".0". */
function formatFollowers(n: number): string {
  if (n < 1_000) return String(n);
  const fmt = (v: number, suffix: string) => {
    const s = v.toFixed(1).replace(/\.0$/, '');
    return `${s}${suffix}`;
  };
  if (n < 1_000_000) return fmt(n / 1_000, 'K');
  if (n < 1_000_000_000) return fmt(n / 1_000_000, 'M');
  return fmt(n / 1_000_000_000, 'B');
}

function ResourceCard({ r }: { r: LandingResource }): JSX.Element {
  const meta = PLATFORM[r.platform];
  const title = r.displayName ?? (r.handle ? `@${r.handle}` : meta.label);
  const showHandle = !!r.handle && r.displayName !== null;

  const inner = (
    <>
      {/* platform glow — anchored top-right, brand-tinted, very faint */}
      <span
        aria-hidden
        className="rs-glow"
        style={{ background: `radial-gradient(120px 120px at 100% 0%, ${meta.tint}1f, transparent 70%)` }}
      />
      <div className="rs-card-head">
        <span className="rs-avatar" style={{ '--rs-tint': meta.tint } as CSSProperties}>
          {r.avatarUrl ? (
            <img src={r.avatarUrl} alt="" className="rs-avatar-img" loading="lazy" />
          ) : (
            <Icon name={meta.icon} size={20} />
          )}
        </span>
        <span className="rs-platform-tag">
          <Icon name={meta.icon} size={12} />
          {meta.label}
        </span>
      </div>

      <div className="rs-card-body">
        <span className="text-body-sm rs-name">{title}</span>
        {showHandle && <span className="text-micro rs-handle">@{r.handle}</span>}
      </div>

      <div className="rs-card-foot">
        {r.followerCount !== null ? (
          <span className="rs-followers">
            <span className="rs-followers-num">{formatFollowers(r.followerCount)}</span>
            <span className="text-micro rs-followers-label">followers</span>
          </span>
        ) : (
          <span />
        )}
        {r.url && <span className="rs-arrow" aria-hidden>↗</span>}
      </div>
    </>
  );

  if (r.url) {
    return (
      <a
        href={r.url}
        target="_blank"
        rel="noopener noreferrer"
        className="rs-card rs-card-link"
      >
        {inner}
      </a>
    );
  }
  return <div className="rs-card">{inner}</div>;
}

/**
 * SHARED presentational showcase. No data fetching, no auth-bound router hooks.
 * Reused verbatim by the public landing AND the admin live-preview, so the
 * `{ resources }` signature is a hard contract.
 */
export function ResourceShowcase({ resources }: { resources: LandingResource[] }): JSX.Element {
  if (resources.length === 0) {
    return (
      <div className="rs-empty">
        <span className="rs-empty-orb" aria-hidden />
        <span className="text-subhead" style={{ color: 'var(--color-ink)' }}>No resources yet</span>
        <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>
          Featured channels and profiles will appear here once they’re published.
        </span>
      </div>
    );
  }

  return (
    <>
      <div className="rs-grid">
        {resources.map((r) => (
          <ResourceCard key={`${r.platform}:${r.handle ?? r.order}`} r={r} />
        ))}
      </div>

      {/* Scoped styles — keeps the component self-contained for both consumers. */}
      <style>{`
        .rs-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: var(--space-lg);
        }
        .rs-card {
          position: relative;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          gap: var(--space-lg);
          min-height: 168px;
          padding: var(--space-xl);
          background: var(--color-surface-2);
          border: 1px solid var(--color-hairline);
          border-radius: var(--radius-lg);
          text-decoration: none;
          color: var(--color-ink);
          transition: transform 0.18s ease, border-color 0.18s ease, background 0.18s ease;
        }
        .rs-card-link:hover {
          transform: translateY(-3px);
          border-color: var(--color-hairline-strong);
          background: var(--color-surface-3);
        }
        .rs-glow {
          position: absolute; inset: 0;
          opacity: 0.9;
          pointer-events: none;
        }
        .rs-card-head {
          position: relative;
          display: flex; align-items: center; justify-content: space-between;
        }
        .rs-avatar {
          display: inline-flex; align-items: center; justify-content: center;
          width: 44px; height: 44px;
          border-radius: var(--radius-md);
          background: var(--color-surface-3);
          border: 1px solid var(--color-hairline);
          color: var(--color-ink);
          overflow: hidden;
          box-shadow: 0 0 0 1px color-mix(in srgb, var(--rs-tint) 22%, transparent) inset;
        }
        .rs-avatar-img { width: 100%; height: 100%; object-fit: cover; }
        .rs-platform-tag {
          display: inline-flex; align-items: center; gap: 5px;
          padding: 3px 9px;
          border-radius: var(--radius-pill);
          background: var(--color-surface-1);
          border: 1px solid var(--color-hairline);
          color: var(--color-ink-muted);
          font-size: 11px; font-weight: 500; letter-spacing: -0.11px;
        }
        .rs-card-body {
          position: relative;
          display: flex; flex-direction: column; gap: 3px;
          flex: 1;
        }
        .rs-name {
          color: var(--color-ink);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .rs-handle { color: var(--color-ink-dim); }
        .rs-card-foot {
          position: relative;
          display: flex; align-items: flex-end; justify-content: space-between;
        }
        .rs-followers { display: inline-flex; align-items: baseline; gap: 6px; }
        .rs-followers-num {
          font-size: 20px; font-weight: 600; letter-spacing: -0.6px;
          color: var(--color-ink);
          font-variant-numeric: tabular-nums;
        }
        .rs-followers-label { color: var(--color-ink-muted); }
        .rs-arrow {
          color: var(--color-ink-dim);
          font-size: 15px;
          transition: color 0.18s ease, transform 0.18s ease;
        }
        .rs-card-link:hover .rs-arrow {
          color: var(--color-accent);
          transform: translate(2px, -2px);
        }
        .rs-empty {
          display: flex; flex-direction: column; align-items: center; gap: var(--space-sm);
          text-align: center;
          padding: var(--space-section) var(--space-xl);
          background: var(--color-surface-1);
          border: 1px dashed var(--color-hairline-strong);
          border-radius: var(--radius-xl);
        }
        .rs-empty-orb {
          width: 40px; height: 40px; margin-bottom: var(--space-xs);
          border-radius: var(--radius-pill);
          background: var(--color-success-soft);
          box-shadow: 0 0 24px var(--color-success-soft);
        }
      `}</style>
    </>
  );
}
