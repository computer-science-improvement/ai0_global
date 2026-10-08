// Spec 026 FR-007: "Networks run by AI" — the showcase grouped by network, with the
// agent that runs each network and an aiRun badge on every resource.
//
// SHARED presentational component: no data fetching and no router hooks. The public
// landing (/) and the admin live preview (/app/landing) both render it with the same
// payload shape (GET /api/landing/networks), so the preview equals the page.
import type { CSSProperties, JSX } from 'react';
import { motion } from 'motion/react';
import type { LandingNetwork, LandingNetworkResource } from '../../api/landing';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { PLATFORM_META, agentChip, aiRunBadge, compact, resourceKey } from '../../lib/landing-view';

const cardVariants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.2, 0.7, 0.2, 1] as const } },
};

function ResourceCard({ r }: { r: LandingNetworkResource }): JSX.Element {
  const meta = PLATFORM_META[r.platform];
  const title = r.displayName ?? (r.handle ? `@${r.handle}` : meta.label);
  const showHandle = !!r.handle && r.displayName !== null;
  const badge = aiRunBadge(r.aiRun);

  return (
    <motion.div className={`rs-card${r.url ? ' rs-card-link' : ''}`} variants={cardVariants}>
      <span
        aria-hidden
        className="rs-glow"
        style={{ background: `radial-gradient(120px 120px at 100% 0%, ${meta.tint}1f, transparent 70%)` }}
      />
      <div className="rs-card-head">
        <span className="rs-avatar" style={{ '--rs-tint': meta.tint } as CSSProperties}>
          {r.avatarUrl ? <img src={r.avatarUrl} alt="" className="rs-avatar-img" loading="lazy" /> : <Icon name={meta.icon} size={20} />}
        </span>
        <span className="rs-platform-tag">
          <Icon name={meta.icon} size={12} />
          {meta.label}
        </span>
      </div>

      <div className="rs-card-body">
        {r.url ? (
          // Stretched link: the whole card opens the profile, the "Ads here" link sits above it.
          <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-body-sm rs-name rs-stretch">{title}</a>
        ) : (
          <span className="text-body-sm rs-name">{title}</span>
        )}
        {showHandle && <span className="text-micro rs-handle">@{r.handle}</span>}
      </div>

      <div className="rs-badges">
        <Badge tone={badge.tone} title={badge.title}>{badge.label}</Badge>
      </div>

      <div className="rs-card-foot">
        {r.followerCount !== null ? (
          <span className="rs-followers">
            <span className="rs-followers-num">{compact(r.followerCount)}</span>
            <span className="text-micro rs-followers-label">followers</span>
          </span>
        ) : <span />}
        {r.adDmUrl ? (
          <a href={r.adDmUrl} target="_blank" rel="noopener" className="rs-ad-link">
            Ads here <Icon name="telegram" size={12} />
          </a>
        ) : r.url ? <span className="rs-arrow" aria-hidden>↗</span> : null}
      </div>
    </motion.div>
  );
}

function NetworkBlock({ n }: { n: LandingNetwork }): JSX.Element {
  const chip = agentChip(n.agent);
  const standalone = n.name === null;
  return (
    <section className="ns-net" aria-label={standalone ? 'Standalone channels' : n.name ?? undefined}>
      <header className="ns-head">
        <div className="ns-head-main">
          <h3 className="ns-title">{standalone ? 'Standalone channels' : n.name}</h3>
          {chip && n.agent && (
            <span className={`ns-agent ns-agent-${n.agent.mode}`}>
              <span aria-hidden>{n.agent.emoji ?? '🤖'}</span>
              {chip}
            </span>
          )}
          {n.blurb && <p className="text-body-sm ns-blurb">{n.blurb}</p>}
        </div>
        <div className="ns-head-side">
          {n.followers !== null && n.followers > 0 && (
            <span className="ns-followers"><b>{compact(n.followers)}</b> followers</span>
          )}
          <span className="ns-platforms" aria-label={`Platforms: ${n.platforms.map((p) => PLATFORM_META[p].label).join(', ')}`}>
            {n.platforms.map((p) => (
              <span key={p} className="ns-platform" title={PLATFORM_META[p].label} style={{ '--rs-tint': PLATFORM_META[p].tint } as CSSProperties}>
                <Icon name={PLATFORM_META[p].icon} size={13} />
              </span>
            ))}
          </span>
          {n.adDmUrl && (
            <a href={n.adDmUrl} target="_blank" rel="noopener" className="rs-ad-link">
              Advertise in this network <Icon name="telegram" size={12} />
            </a>
          )}
        </div>
      </header>

      <motion.div
        className="rs-grid"
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: '-60px' }}
        variants={{ hidden: {}, show: { transition: { staggerChildren: 0.06 } } }}
      >
        {n.resources.map((r, i) => <ResourceCard key={`${resourceKey(r)}#${i}`} r={r} />)}
      </motion.div>
    </section>
  );
}

export function NetworkShowcase({ networks }: { networks: LandingNetwork[] }): JSX.Element {
  const withResources = networks.filter((n) => n.resources.length > 0);
  return (
    <>
      {withResources.length === 0 ? (
        <div className="rs-empty">
          <span className="rs-empty-orb" aria-hidden />
          <span className="text-subhead" style={{ color: 'var(--color-ink)' }}>No resources yet</span>
          <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>
            Featured channels and profiles will appear here once they’re published.
          </span>
        </div>
      ) : (
        <div className="ns-list">
          {withResources.map((n) => <NetworkBlock key={n.name ?? '__standalone'} n={n} />)}
        </div>
      )}

      {/* Scoped styles: keeps the component self-contained for both consumers. */}
      <style>{`
        .ns-list { display: flex; flex-direction: column; gap: var(--space-xxl); }
        .ns-net {
          display: flex; flex-direction: column; gap: var(--space-lg);
          padding: var(--space-xl);
          background: var(--color-surface-1);
          border: 1px solid var(--color-hairline-soft);
          border-radius: var(--radius-xl);
          min-width: 0;
        }
        .ns-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-lg); flex-wrap: wrap; }
        .ns-head-main { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-sm); min-width: 0; flex: 1 1 280px; }
        .ns-title { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.4px; color: var(--color-ink); overflow-wrap: anywhere; }
        .ns-agent {
          display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
          padding: 4px 10px; border-radius: var(--radius-pill);
          font-size: 12px; font-weight: 500; letter-spacing: -0.12px;
          border: 1px solid var(--color-hairline);
          background: var(--color-surface-2); color: var(--color-ink-muted);
          overflow-wrap: anywhere;
        }
        .ns-agent-live {
          color: var(--color-success);
          border-color: color-mix(in srgb, var(--color-success) 35%, transparent);
          background: var(--color-success-soft);
        }
        .ns-blurb { margin: 0; color: var(--color-ink-muted); max-width: 60ch; }
        .ns-head-side { display: flex; flex-direction: column; align-items: flex-end; gap: var(--space-sm); }
        @media (max-width: 640px) { .ns-head-side { align-items: flex-start; } }
        .ns-followers { font-size: 13px; color: var(--color-ink-muted); }
        .ns-followers b { color: var(--color-ink); font-weight: 600; font-variant-numeric: tabular-nums; }
        .ns-platforms { display: inline-flex; gap: 6px; flex-wrap: wrap; }
        .ns-platform {
          display: inline-flex; align-items: center; justify-content: center;
          width: 28px; height: 28px; border-radius: var(--radius-pill);
          background: var(--color-surface-2); border: 1px solid var(--color-hairline-soft);
          color: var(--rs-tint, var(--color-ink-muted));
        }

        .rs-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(min(240px, 100%), 1fr));
          gap: var(--space-lg);
        }
        .rs-card {
          position: relative;
          isolation: isolate;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          gap: var(--space-md);
          min-height: 168px;
          padding: var(--space-xl);
          background: var(--color-surface-2);
          border: 1px solid var(--color-hairline);
          border-radius: var(--radius-lg);
          color: var(--color-ink);
          transition: transform 0.18s ease, border-color 0.18s ease, background 0.18s ease;
        }
        .rs-card-link:hover, .rs-card-link:focus-within {
          transform: translateY(-3px);
          border-color: var(--color-hairline-strong);
          background: var(--color-surface-3);
        }
        @media (prefers-reduced-motion: reduce) {
          .rs-card, .rs-arrow { transition: none; }
          .rs-card-link:hover, .rs-card-link:focus-within { transform: none; }
        }
        .rs-glow { position: absolute; inset: 0; z-index: -1; opacity: 0.9; pointer-events: none; }
        .rs-card-head { position: relative; display: flex; align-items: center; justify-content: space-between; }
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
        .rs-card-body { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
        .rs-name {
          color: var(--color-ink); text-decoration: none;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .rs-stretch::after { content: ''; position: absolute; inset: 0; z-index: 0; }
        .rs-stretch:focus-visible { outline: none; }
        .rs-card-link:has(.rs-stretch:focus-visible) { outline: 2px solid var(--color-accent); outline-offset: 2px; }
        .rs-handle { color: var(--color-ink-dim); }
        .rs-badges { display: flex; flex-wrap: wrap; gap: 6px; }
        .rs-card-foot { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-sm); }
        .rs-followers { display: inline-flex; align-items: baseline; gap: 6px; }
        .rs-followers-num {
          font-size: 20px; font-weight: 600; letter-spacing: -0.6px;
          color: var(--color-ink);
          font-variant-numeric: tabular-nums;
        }
        .rs-followers-label { color: var(--color-ink-muted); }
        .rs-arrow { color: var(--color-ink-dim); font-size: 15px; transition: color 0.18s ease, transform 0.18s ease; }
        .rs-card-link:hover .rs-arrow { color: var(--color-accent); transform: translate(2px, -2px); }
        .rs-ad-link {
          position: relative; z-index: 1;
          display: inline-flex; align-items: center; gap: 5px;
          padding: 5px 10px; border-radius: var(--radius-pill);
          font-size: 12px; font-weight: 600; letter-spacing: -0.12px;
          color: var(--color-accent); text-decoration: none;
          border: 1px solid color-mix(in srgb, var(--color-accent) 40%, transparent);
          background: color-mix(in srgb, var(--color-accent) 8%, transparent);
          min-height: 32px;
        }
        .rs-ad-link:hover { background: color-mix(in srgb, var(--color-accent) 16%, transparent); opacity: 1; }
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
        @media (max-width: 600px) {
          .ns-net { padding: var(--space-lg); }
          .rs-card { padding: var(--space-lg); }
        }
      `}</style>
    </>
  );
}
