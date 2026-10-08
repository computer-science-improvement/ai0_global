import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { Badge } from '../components/ui/Badge';
import { Icon, type IconName } from '../components/ui/Icon';
import { NetworkShowcase } from '../components/landing/NetworkShowcase';
import { MediaKit } from '../components/landing/MediaKit';
import { useLandingNetworks } from '../api/landing';
import { audienceStats } from '../lib/landing-view';

export const Route = createFileRoute('/')({ component: LandingPage });

const PLATFORMS: { icon: IconName; label: string; tint: string }[] = [
  { icon: 'telegram',  label: 'Telegram',  tint: '#2aabee' },
  { icon: 'instagram', label: 'Instagram', tint: '#e1306c' },
  { icon: 'facebook',  label: 'Facebook',  tint: '#1877f2' },
  { icon: 'threads',   label: 'Threads',   tint: '#ededed' },
  { icon: 'tiktok',    label: 'TikTok',    tint: '#25f4ee' },
];

const STEPS: { icon: IconName; title: string; body: string }[] = [
  { icon: 'strategies', title: 'Create',   body: 'AI strategies compose posts from curated sources — recipes, news, prompts, stories.' },
  { icon: 'calendar',   title: 'Schedule', body: 'Every channel runs on its own cadence; queues and cron windows do the timing.' },
  { icon: 'channels',   title: 'Publish',  body: 'One pipeline ships the same story to five platforms, formatted for each.' },
  { icon: 'analytics',  title: 'Track',    body: 'Followers, reach and the ad graph land in one dashboard, automatically.' },
];

// Shared scroll-reveal preset — fade + rise, fires once when in view.
const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.55, ease: [0.2, 0.7, 0.2, 1] as const },
};

/** 12_345 → "12.3K" — compact display for the live network stats. */
function compact(n: number): string {
  if (n < 1_000) return String(n);
  const fmt = (v: number, s: string) => `${v.toFixed(1).replace(/\.0$/, '')}${s}`;
  if (n < 1_000_000) return fmt(n / 1_000, 'K');
  return fmt(n / 1_000_000, 'M');
}

/** Self-contained rAF count-up: starts when the number scrolls into view,
 *  renders the final value immediately under prefers-reduced-motion. */
function CountUp({ to }: { to: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.textContent = compact(to);
      return;
    }
    let raf = 0;
    const run = () => {
      const t0 = performance.now();
      const dur = 1100;
      const step = (t: number) => {
        const p = Math.min(1, (t - t0) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = compact(Math.round(to * eased));
        if (p < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    const io = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { io.disconnect(); run(); } },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [to]);
  return <span ref={ref} className="lp-stat-num">0</span>;
}

/**
 * Hero centerpiece — the product, drawn: one hub fanning content out to five
 * platform nodes. Pure SVG paths + SMIL packets (no deps); packets hide under
 * prefers-reduced-motion, and below 640px the diagram collapses to a plain
 * chip row (the lines don't survive wrapping).
 */
function NetworkVisual() {
  // Path endpoints in viewBox units — chips sit at the same % positions.
  const XS = [72, 216, 360, 504, 648]; // 10% 30% 50% 70% 90% of 720
  return (
    <div className="lp-net" aria-hidden>
      <div className="lp-net-hub">
        <span className="dot" />
        ai0 pipeline
      </div>
      <svg className="lp-net-svg" viewBox="0 0 720 190" preserveAspectRatio="xMidYMax meet">
        {XS.map((x, i) => {
          const d = `M 360 8 C 360 92, ${x} 74, ${x} 168`;
          return (
            <g key={x}>
              <path d={d} className="lp-net-line" />
              <circle r="2.6" className="lp-net-packet" style={{ animationDelay: `${i * 0.4}s` }}>
                <animateMotion dur="2.6s" begin={`${i * 0.42}s`} repeatCount="indefinite" path={d} />
              </circle>
            </g>
          );
        })}
      </svg>
      <div className="lp-net-row">
        {PLATFORMS.map((p) => (
          <span key={p.label} className="lp-rail-item" style={{ '--lp-tint': p.tint } as React.CSSProperties}>
            <Icon name={p.icon} size={15} />
            {p.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function LandingPage() {
  const { data: networks, isLoading, isError } = useLandingNetworks();
  const stats = audienceStats(networks);

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
        <nav style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
          <a href="#advertise" className="lp-topbar-cta">Advertise</a>
          <a href="/app" className="lp-topbar-cta">Sign in →</a>
        </nav>
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
            <a href="#advertise" className="lp-hero-cta-secondary">Advertise with us</a>
          </motion.div>

          {/* The product, drawn: hub → five platforms with traveling packets. */}
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.32, ease: [0.2, 0.7, 0.2, 1] }}
            style={{ width: '100%' }}
          >
            <NetworkVisual />
          </motion.div>

          {/* Live network stats — real numbers from the same API as the grid. */}
          {!isLoading && !isError && stats.resources > 0 && (
            <motion.div className="lp-stats" {...reveal}>
              <span className="lp-stat">
                <CountUp to={stats.followers} />
                <span className="text-micro lp-stat-label">followers reached</span>
              </span>
              <span className="lp-stat-divider" />
              <span className="lp-stat">
                <CountUp to={stats.resources} />
                <span className="text-micro lp-stat-label">channels &amp; profiles</span>
              </span>
              <span className="lp-stat-divider" />
              <span className="lp-stat">
                <CountUp to={stats.platforms} />
                <span className="text-micro lp-stat-label">platforms</span>
              </span>
            </motion.div>
          )}
        </section>

        {/* ── Resources showcase ────────────────────────────────── */}
        <motion.section id="resources" className="lp-section" {...reveal}>
          <div className="lp-section-head">
            <span className="text-eyebrow">The network</span>
            <h2 className="text-display-md lp-section-title">Networks run by AI</h2>
            <p className="text-body lp-section-sub">
              Each network is a set of channels and profiles with one AI agent in charge. The badge on every
              card says who publishes there today: an agent, an agent still in training, or the automated pipeline.
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

          {!isLoading && !isError && <NetworkShowcase networks={networks ?? []} />}
        </motion.section>

        {/* ── How it works ──────────────────────────────────────── */}
        <section className="lp-section">
          <motion.div className="lp-section-head" {...reveal}>
            <span className="text-eyebrow">The pipeline</span>
            <h2 className="text-display-md lp-section-title">How it works</h2>
          </motion.div>
          <motion.div
            className="lp-steps"
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: '-80px' }}
            variants={{ hidden: {}, show: { transition: { staggerChildren: 0.09 } } }}
          >
            {STEPS.map((s, i) => (
              <motion.div
                key={s.title}
                className="lp-step"
                variants={{
                  hidden: { opacity: 0, y: 20 },
                  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.2, 0.7, 0.2, 1] } },
                }}
              >
                <span className="lp-step-index">0{i + 1}</span>
                <span className="lp-step-icon"><Icon name={s.icon} size={17} /></span>
                <span className="text-body lp-step-title">{s.title}</span>
                <span className="text-body-sm lp-step-body">{s.body}</span>
              </motion.div>
            ))}
          </motion.div>
        </section>

        {/* ── Advertising block ─────────────────────────────────── */}
        <motion.section id="advertise" className="lp-section" {...reveal}>
          <div className="lp-ad card-featured">
            <span className="lp-ad-glow" aria-hidden />
            <div className="lp-ad-inner">
              <Badge tone="warning">Self-serve — coming soon</Badge>
              <h2 className="text-display-md lp-ad-title">Advertise with us</h2>
              <p className="text-body lp-ad-sub">
                Reach engaged audiences across our entire multi-platform network from one place.
                Every placement is labelled as an ad (#реклама) and comes with a 24 h and 72 h stats report.
              </p>
              {/* Media kit: live channel stats + the current price list (renders only when prices exist). */}
              <MediaKit />
              <a
                href="mailto:gm.tupota.valik@gmail.com?subject=Ad%20placement%20—%20ai0%20network"
                className="lp-hero-cta-primary"
              >
                Contact us
              </a>
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
        <span className="lp-footer-links">
          <a href="#resources" className="lp-footer-link">The network</a>
          <a href="#advertise" className="lp-footer-link">Advertise</a>
          <a href="/app" className="lp-footer-link">Sign in</a>
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
          animation: lp-breathe 7s ease-in-out infinite;
        }
        @keyframes lp-breathe { 0%, 100% { opacity: 0.55; } 50% { opacity: 0.72; } }
        @media (prefers-reduced-motion: reduce) { .lp-mesh { animation: none; } }
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
        .lp-hero-cta-secondary {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 12px 22px; border-radius: var(--radius-sm);
          background: transparent; color: var(--color-ink-muted);
          border: 1px solid var(--color-hairline-strong);
          text-decoration: none; font-size: 15px; font-weight: 500; letter-spacing: -0.15px;
          transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
        }
        .lp-hero-cta-secondary:hover {
          color: var(--color-ink);
          border-color: var(--color-hairline-strong);
          background: var(--color-surface-2);
        }

        /* ── Network diagram ─────────────────────────────────── */
        .lp-net {
          position: relative;
          width: 100%; max-width: 760px;
          margin: var(--space-section) auto 0;
          display: flex; flex-direction: column; align-items: center;
        }
        .lp-net-hub {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 8px 16px;
          border-radius: var(--radius-pill);
          background: var(--color-surface-2);
          border: 1px solid var(--color-hairline-strong);
          color: var(--color-ink);
          font-size: 13px; font-weight: 600; letter-spacing: -0.13px;
          box-shadow: 0 0 24px color-mix(in srgb, var(--color-accent) 18%, transparent);
        }
        .lp-net-hub .dot {
          width: 8px; height: 8px; border-radius: var(--radius-pill);
          background: var(--color-accent);
          box-shadow: 0 0 10px var(--color-accent);
          animation: lp-pulse 2.4s ease-in-out infinite;
        }
        .lp-net-svg {
          width: 100%; height: auto; display: block;
          margin: -4px 0;
        }
        .lp-net-line {
          fill: none;
          stroke: var(--color-hairline-strong);
          stroke-width: 1.2;
          stroke-dasharray: 3 5;
          animation: lp-dash 3.2s linear infinite;
        }
        @keyframes lp-dash { to { stroke-dashoffset: -16; } }
        .lp-net-packet {
          fill: var(--color-accent);
          filter: drop-shadow(0 0 4px var(--color-accent));
        }
        .lp-net-row {
          display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--space-sm);
          width: 100%;
        }
        .lp-rail-item {
          display: inline-flex; align-items: center; gap: 7px;
          padding: 8px 14px; border-radius: var(--radius-pill);
          background: var(--color-surface-1);
          border: 1px solid var(--color-hairline-soft);
          color: var(--color-ink-muted);
          font-size: 13px; font-weight: 500; letter-spacing: -0.13px;
          transition: border-color 0.15s ease, color 0.15s ease, transform 0.15s ease;
        }
        .lp-rail-item:hover {
          color: var(--color-ink);
          border-color: color-mix(in srgb, var(--lp-tint, var(--color-accent)) 45%, transparent);
          transform: translateY(-2px);
        }
        .lp-rail-item svg { color: var(--lp-tint, currentColor); opacity: 0.9; }
        @media (prefers-reduced-motion: reduce) {
          .lp-net-packet { display: none; }
          .lp-net-line { animation: none; }
        }
        @media (max-width: 640px) {
          .lp-net-svg, .lp-net-hub { display: none; }
          .lp-net { margin-top: var(--space-xxl); }
          .lp-net-row { justify-content: center; }
        }

        /* ── Live stats ──────────────────────────────────────── */
        .lp-stats {
          display: flex; align-items: center; justify-content: center;
          gap: var(--space-xxl); flex-wrap: wrap;
          margin-top: var(--space-section);
          min-height: 64px;
        }
        .lp-stat { display: flex; flex-direction: column; align-items: center; gap: 4px; }
        .lp-stat-num {
          font-size: 34px; font-weight: 650; letter-spacing: -1.2px;
          color: var(--color-ink);
          font-variant-numeric: tabular-nums;
          line-height: 1;
        }
        .lp-stat-label { color: var(--color-ink-muted); }
        .lp-stat-divider { width: 1px; height: 34px; background: var(--color-hairline); }
        @media (max-width: 640px) {
          .lp-stats { gap: var(--space-xl); }
          .lp-stat-divider { display: none; }
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
          background: linear-gradient(90deg, var(--color-surface-2) 25%, var(--color-surface-3) 50%, var(--color-surface-2) 75%);
          background-size: 200% 100%;
          border: 1px solid var(--color-hairline);
          animation: lp-shimmer 1.6s ease-in-out infinite;
        }
        @keyframes lp-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }

        /* ── Steps ───────────────────────────────────────────── */
        .lp-steps {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: var(--space-lg);
        }
        @media (max-width: 980px) { .lp-steps { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 480px) { .lp-steps { grid-template-columns: 1fr; } }
        .lp-step {
          position: relative;
          display: flex; flex-direction: column; gap: var(--space-sm);
          padding: var(--space-xl);
          background: var(--color-surface-1);
          border: 1px solid var(--color-hairline-soft);
          border-radius: var(--radius-lg);
        }
        .lp-step-index {
          position: absolute; top: var(--space-lg); right: var(--space-lg);
          font-size: 12px; font-weight: 600; letter-spacing: 0.4px;
          color: var(--color-ink-dim);
          font-variant-numeric: tabular-nums;
        }
        .lp-step-icon {
          display: inline-flex; align-items: center; justify-content: center;
          width: 38px; height: 38px;
          border-radius: var(--radius-md);
          background: var(--color-surface-2);
          border: 1px solid var(--color-hairline);
          color: var(--color-accent);
          margin-bottom: var(--space-xs);
        }
        .lp-step-title { color: var(--color-ink); font-weight: 600; }
        .lp-step-body { color: var(--color-ink-muted); }

        .lp-ad {
          position: relative; overflow: hidden;
          text-align: center;
          padding: var(--space-section) var(--space-xl);
          border: 1px solid var(--color-hairline);
        }
        .lp-ad-glow {
          position: absolute; inset: 0; pointer-events: none;
          background:
            radial-gradient(420px 220px at 50% 0%, color-mix(in srgb, var(--color-warning) 12%, transparent), transparent 70%),
            radial-gradient(360px 200px at 92% 100%, color-mix(in srgb, var(--color-accent) 8%, transparent), transparent 70%);
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
        .lp-footer-links { display: inline-flex; align-items: center; gap: var(--space-lg); }
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
        }
      `}</style>
    </div>
  );
}
