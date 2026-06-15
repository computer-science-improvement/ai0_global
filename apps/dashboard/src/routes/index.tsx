import { createFileRoute } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Icon, type IconName } from '../components/ui/Icon';
import { ResourceShowcase } from '../components/landing/ResourceShowcase';
import { useLandingResources } from '../api/landing';

export const Route = createFileRoute('/')({ component: LandingPage });

const PLATFORMS: { icon: IconName; label: string }[] = [
  { icon: 'telegram',  label: 'Telegram' },
  { icon: 'instagram', label: 'Instagram' },
  { icon: 'facebook',  label: 'Facebook' },
  { icon: 'threads',   label: 'Threads' },
  { icon: 'tiktok',    label: 'TikTok' },
];

// Shared scroll-reveal preset — fade + rise, fires once when in view.
const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.55, ease: [0.2, 0.7, 0.2, 1] as const },
};

function LandingPage() {
  const { data, isLoading, isError } = useLandingResources();
  const resources = data ?? [];

  return (
    <div className="lp-root">
      {/* Atmosphere: emerald mesh glow + faint grid, behind everything. */}
      <div className="lp-bg" aria-hidden>
        <span className="lp-mesh" />
        <span className="lp-grid" />
      </div>

      {/* ── Top bar ─────────────────────────────────────────────── */}
      <header className="lp-topbar">
        <span className="wordmark">
          <span className="dot" />
          ai0
        </span>
      </header>

      <main className="lp-main">
        {/* ── Hero ──────────────────────────────────────────────── */}
        <section className="lp-hero">
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.2, 0.7, 0.2, 1] }}
            className="lp-hero-pill"
          >
            <span className="lp-hero-pulse" />
            One network · five platforms
          </motion.div>

          <motion.h1
            className="text-display-xl lp-hero-title"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.65, delay: 0.06, ease: [0.2, 0.7, 0.2, 1] }}
          >
            Content, everywhere<br />
            it should be.
          </motion.h1>

          <motion.p
            className="text-subhead lp-hero-sub"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.65, delay: 0.14, ease: [0.2, 0.7, 0.2, 1] }}
          >
            A multi-channel publishing network that creates, schedules and ships posts
            across Telegram, Instagram, Facebook, Threads and TikTok — automatically.
          </motion.p>

          <motion.div
            className="lp-hero-cta"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.65, delay: 0.22, ease: [0.2, 0.7, 0.2, 1] }}
          >
            <a href="#resources" className="lp-hero-cta-primary">Explore the network ↓</a>
          </motion.div>

          {/* Platform rail — staggered children. */}
          <motion.div
            className="lp-rail"
            initial="hidden"
            animate="show"
            variants={{ hidden: {}, show: { transition: { staggerChildren: 0.06, delayChildren: 0.3 } } }}
          >
            {PLATFORMS.map((p) => (
              <motion.span
                key={p.label}
                className="lp-rail-item"
                variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }}
              >
                <Icon name={p.icon} size={15} />
                {p.label}
              </motion.span>
            ))}
          </motion.div>
        </section>

        {/* ── Resources showcase ────────────────────────────────── */}
        <motion.section id="resources" className="lp-section" {...reveal}>
          <div className="lp-section-head">
            <span className="text-eyebrow">The network</span>
            <h2 className="text-display-md lp-section-title">Channels &amp; profiles we run</h2>
            <p className="text-body lp-section-sub">
              Live audiences across every surface, published from a single pipeline.
            </p>
          </div>

          {isLoading && (
            <div className="lp-skeleton-grid">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="lp-skeleton" />
              ))}
            </div>
          )}

          {isError && !isLoading && (
            <div className="callout-warning" style={{ maxWidth: 520 }}>
              <Icon name="warning" size={16} />
              <span>Couldn’t load the showcase right now. Please try again shortly.</span>
            </div>
          )}

          {!isLoading && !isError && <ResourceShowcase resources={resources} />}
        </motion.section>

        {/* ── Advertising block ─────────────────────────────────── */}
        <motion.section className="lp-section" {...reveal}>
          <div className="lp-ad card-featured">
            <span className="lp-ad-glow" aria-hidden />
            <div className="lp-ad-inner">
              <Badge tone="warning">Coming soon</Badge>
              <h2 className="text-display-md lp-ad-title">Advertise with us</h2>
              <p className="text-body lp-ad-sub">
                Reach engaged audiences across our entire multi-platform network from one place.
                Self-serve campaigns and sponsored placements are on the way.
              </p>
              <Button variant="primary" disabled style={{ padding: '12px 22px', fontSize: 15 }}>
                Book a placement
              </Button>
            </div>
          </div>
        </motion.section>
      </main>

      {/* ── Footer ────────────────────────────────────────────── */}
      <footer className="lp-footer">
        <span className="wordmark">
          <span className="dot" />
          ai0
        </span>
        <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
          © {new Date().getFullYear()} ai0 — multi-channel publishing network
        </span>
      </footer>

      <style>{`
        .lp-root {
          position: relative;
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          background: var(--color-canvas);
          color: var(--color-ink);
          overflow-x: clip;
        }
        .lp-bg { position: fixed; inset: 0; z-index: 0; pointer-events: none; }
        .lp-mesh {
          position: absolute; top: -260px; left: 50%; transform: translateX(-50%);
          width: 1100px; height: 760px;
          background:
            radial-gradient(closest-side, color-mix(in srgb, var(--color-accent) 26%, transparent), transparent 72%),
            radial-gradient(closest-side at 30% 40%, color-mix(in srgb, var(--color-accent-deep) 18%, transparent), transparent 70%);
          filter: blur(28px);
          opacity: 0.55;
        }
        .lp-grid {
          position: absolute; inset: 0;
          background-image:
            linear-gradient(var(--color-hairline-soft) 1px, transparent 1px),
            linear-gradient(90deg, var(--color-hairline-soft) 1px, transparent 1px);
          background-size: 64px 64px;
          mask-image: radial-gradient(120% 80% at 50% 0%, #000 0%, transparent 65%);
          -webkit-mask-image: radial-gradient(120% 80% at 50% 0%, #000 0%, transparent 65%);
          opacity: 0.5;
        }

        .lp-topbar, .lp-main, .lp-footer {
          position: relative; z-index: 1;
          width: 100%; max-width: 1180px; margin: 0 auto;
          padding-left: var(--space-xl); padding-right: var(--space-xl);
        }
        .lp-topbar {
          display: flex; align-items: center; justify-content: space-between;
          padding-top: var(--space-xl); padding-bottom: var(--space-xl);
        }
        .lp-topbar .wordmark { font-size: 16px; }
        .lp-topbar-cta {
          color: var(--color-ink-muted); text-decoration: none;
          font-size: 14px; font-weight: 500; letter-spacing: -0.14px;
          padding: 8px 14px; border-radius: var(--radius-sm);
          transition: color 0.12s ease, background 0.12s ease;
        }
        .lp-topbar-cta:hover { color: var(--color-ink); background: var(--color-surface-2); opacity: 1; }

        .lp-main { flex: 1; }

        .lp-hero {
          display: flex; flex-direction: column; align-items: center; text-align: center;
          padding-top: var(--space-section);
          padding-bottom: var(--space-section);
        }
        .lp-hero-pill {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 6px 14px; margin-bottom: var(--space-xl);
          border-radius: var(--radius-pill);
          background: var(--color-surface-2);
          border: 1px solid var(--color-hairline);
          color: var(--color-ink-muted);
          font-size: 13px; font-weight: 500; letter-spacing: -0.13px;
        }
        .lp-hero-pulse {
          width: 7px; height: 7px; border-radius: var(--radius-pill);
          background: var(--color-accent);
          box-shadow: 0 0 12px var(--color-accent);
          animation: lp-pulse 2.4s ease-in-out infinite;
        }
        @keyframes lp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

        .lp-hero-title { max-width: 14ch; margin: 0; }
        .lp-hero-sub {
          max-width: 56ch; margin: var(--space-xl) 0 0;
          color: var(--color-ink-muted);
        }
        .lp-hero-cta {
          display: flex; align-items: center; gap: var(--space-xl);
          margin-top: var(--space-xxl); flex-wrap: wrap; justify-content: center;
        }
        .lp-hero-cta-primary {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 12px 22px; border-radius: var(--radius-sm);
          background: var(--color-accent); color: var(--color-on-accent);
          text-decoration: none; font-size: 15px; font-weight: 600; letter-spacing: -0.15px;
          transition: background 0.15s ease;
        }
        .lp-hero-cta-primary:hover { background: var(--color-accent-deep); }

        .lp-rail {
          display: flex; flex-wrap: wrap; justify-content: center; gap: var(--space-sm);
          margin-top: var(--space-section);
        }
        .lp-rail-item {
          display: inline-flex; align-items: center; gap: 7px;
          padding: 8px 14px; border-radius: var(--radius-pill);
          background: var(--color-surface-1);
          border: 1px solid var(--color-hairline-soft);
          color: var(--color-ink-muted);
          font-size: 13px; font-weight: 500; letter-spacing: -0.13px;
        }

        .lp-section { padding-top: var(--space-section); }
        .lp-section-head { margin-bottom: var(--space-xxl); }
        .lp-section-title { margin: var(--space-sm) 0 0; }
        .lp-section-sub { margin: var(--space-md) 0 0; color: var(--color-ink-muted); max-width: 56ch; }

        .lp-skeleton-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: var(--space-lg);
        }
        .lp-skeleton {
          min-height: 168px; border-radius: var(--radius-lg);
          background: var(--color-surface-2);
          border: 1px solid var(--color-hairline);
          animation: lp-shimmer 1.4s ease-in-out infinite;
        }
        @keyframes lp-shimmer { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }

        .lp-ad {
          position: relative; overflow: hidden;
          text-align: center;
          padding: var(--space-section) var(--space-xl);
          border: 1px solid var(--color-hairline);
        }
        .lp-ad-glow {
          position: absolute; inset: 0; pointer-events: none;
          background: radial-gradient(420px 220px at 50% 0%, color-mix(in srgb, var(--color-warning) 12%, transparent), transparent 70%);
        }
        .lp-ad-inner {
          position: relative;
          display: flex; flex-direction: column; align-items: center; gap: var(--space-lg);
        }
        .lp-ad-title { margin: 0; }
        .lp-ad-sub { margin: 0; max-width: 52ch; color: var(--color-ink-muted); }

        .lp-footer {
          display: flex; align-items: center; justify-content: space-between; gap: var(--space-lg);
          flex-wrap: wrap;
          margin-top: var(--space-section);
          padding-top: var(--space-xl); padding-bottom: var(--space-xl);
          border-top: 1px solid var(--color-hairline);
        }
        .lp-footer .wordmark { font-size: 14px; }
        .lp-footer-link {
          color: var(--color-ink-muted); text-decoration: none;
          font-size: 13px; font-weight: 500; letter-spacing: -0.13px;
        }
        .lp-footer-link:hover { color: var(--color-ink); opacity: 1; }

        @media (max-width: 600px) {
          .lp-topbar, .lp-main, .lp-footer {
            padding-left: var(--space-lg); padding-right: var(--space-lg);
          }
          .lp-hero { padding-top: var(--space-xxl); }
          .lp-hero-cta { gap: var(--space-md); }
          .lp-rail { margin-top: var(--space-xxl); }
        }
      `}</style>
    </div>
  );
}
