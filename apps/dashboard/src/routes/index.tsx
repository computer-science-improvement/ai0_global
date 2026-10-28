import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { MotionConfig, motion } from 'motion/react';
import { Icon } from '../components/ui/Icon';
import { NetworkShowcase } from '../components/landing/NetworkShowcase';
import { MediaKit } from '../components/landing/MediaKit';
import { ProofStrip } from '../components/landing/ProofStrip';
import { HowItWorks } from '../components/landing/HowItWorks';
import { HeroHeadline } from '../components/landing/HeroHeadline';
import { HeroOrbit } from '../components/landing/HeroOrbit';
import { AgentLog } from '../components/landing/AgentLog';
import { ChannelMarquee } from '../components/landing/ChannelMarquee';
import { CountUp } from '../components/landing/CountUp';
import { LoopScope } from '../components/landing/LandingMotion';
import '../components/landing/landing.css';
import { AdCtaPair, AdDmLink, LandingCtaProvider, NoTelegramLink, sendCtaBeacon, type LandingCtaApi } from '../components/landing/cta';
import { AdLeadModal } from '../components/landing/LeadForms';
import { WhiteLabelSection } from '../components/landing/WhiteLabel';
import { whiteLabelVisible } from '../lib/lead-form';
import type { LandingPlacement } from '../api/landing';
import { useLandingNetworks, useLandingPublicConfig, useLandingPulse } from '../api/landing';
import { audienceStats, heroLivePill, heroPlatforms } from '../lib/landing-view';

export const Route = createFileRoute('/')({ component: LandingPage });

// Shared scroll-reveal preset — fade + rise, fires once when in view.
const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.55, ease: [0.2, 0.7, 0.2, 1] as const },
};

function LandingPage() {
  const { data: networks, isLoading, isError } = useLandingNetworks();
  const pulse = useLandingPulse();
  const { data: config } = useLandingPublicConfig();
  const stats = audienceStats(networks);
  // The proof strip and the diagram's live parts hide on any pulse error (503, network).
  const livePulse = pulse.isError ? undefined : pulse.data;
  const platforms = heroPlatforms(networks, livePulse);
  const managerLive = livePulse?.claims.managerLive ?? false;
  const adUrls = config?.adDm.available ? config.adDm.urls : {};
  // Spec 026 FR-012: the white-label section and links exist only while the flag is on.
  const whiteLabel = whiteLabelVisible(config);
  // Spec 026 FR-009/FR-011: clicks on the public page are counted (anonymous beacon), and
  // every ad CTA can open the "No Telegram?" request form with its target prefilled.
  const [adForm, setAdForm] = useState<{ placement: LandingPlacement; target?: string | null } | null>(null);
  const cta: LandingCtaApi = { track: sendCtaBeacon, openAdForm: setAdForm };

  const pill = heroLivePill(livePulse, platforms.length);

  return (
    <MotionConfig reducedMotion="user">
    <LandingCtaProvider value={cta}>
    <div className="lp-root">
      {/* Atmosphere: emerald mesh glow + faint grid, behind everything. */}
      <div className="lp-bg" aria-hidden>
        <span className="lp-mesh" />
        <span className="lp-grid" />
      </div>

      {/* ── Sticky nav ──────────────────────────────────────────── */}
      <header className="lp-nav">
        <div className="lp-wrap lp-nav-in">
          <a href="#top" className="wordmark" aria-label="ai0 home">
            <span className="dot" />
            ai0
          </a>
          <nav className="lp-nav-links" aria-label="Primary">
            <a href="#how-it-works" className="lp-nav-link lp-nav-hide">How it works</a>
            <a href="#networks" className="lp-nav-link lp-nav-hide">Network</a>
            {adUrls.topbar
              ? <AdDmLink href={adUrls.topbar} placement="topbar" className="lp-nav-link">Advertise</AdDmLink>
              : <a href="#advertise" className="lp-nav-link">Advertise</a>}
            {whiteLabel && <a href="#white-label" className="lp-nav-link lp-nav-hide">White label</a>}
            <a href="/app" className="lp-hero-cta-secondary lp-btn-sm lp-nav-signin">Sign in <span aria-hidden>→</span></a>
          </nav>
        </div>
      </header>

      <main className="lp-main">
        {/* ── Hero ──────────────────────────────────────────────── */}
        <LoopScope as="section" className="lp-hero" id="top">
          <div className="lp-scan" aria-hidden="true" />
          <div className="lp-wrap lp-hero-grid">
            <div className="lp-hero-copy">
              <div className={`lp-pill lp-fade${pill.live ? '' : ' is-idle'}`}>
                <span className={`lp-dot ${pill.live ? 'is-live' : 'is-idle'}`} aria-hidden="true" />
                {pill.text}
              </div>

              <HeroHeadline />

              <p className="lp-sub lp-fade" style={{ animationDelay: '0.3s' }}>
                {managerLive
                  ? 'A MANAGER agent watches the whole network and issues directives or advice. '
                  : ''}
                Orchestrator agents plan and write the posts for each channel and profile.
                {managerLive ? '' : ' A MANAGER agent that steers the whole network is coming soon.'}
                {' '}The owner approves structural changes and, during the launch period, each post before it goes out.
              </p>

              <div className="lp-hero-ctas lp-fade" style={{ animationDelay: '0.38s' }}>
                <a href="#networks" className="lp-hero-cta-primary">See the network <span aria-hidden>↓</span></a>
                {adUrls.hero
                  ? (
                    <AdDmLink href={adUrls.hero} placement="hero" className="lp-hero-cta-secondary">
                      <Icon name="telegram" size={15} /> Order an ad in Telegram
                    </AdDmLink>
                  )
                  : <a href="#advertise" className="lp-hero-cta-secondary">Advertise with us</a>}
              </div>
              {adUrls.hero && <NoTelegramLink placement="hero" className="lp-notg lp-hero-notg" />}
              {whiteLabel && (
                <div>
                  <a href="#white-label" className="lp-hero-wl lp-fade" style={{ animationDelay: '0.44s' }} onClick={() => sendCtaBeacon('white_label', 'hero')}>
                    White label for your own resources <span aria-hidden>→</span>
                  </a>
                </div>
              )}

              <ProofStrip pulse={livePulse} variant="row" reserve={pulse.isLoading} />
            </div>

            <div className="lp-hero-art">
              <HeroOrbit networks={networks} pulse={livePulse} platforms={platforms} />
              <AgentLog pulse={livePulse} />
            </div>
          </div>
        </LoopScope>

        <LoopScope as="div">
          <ChannelMarquee networks={networks} loading={isLoading} />
        </LoopScope>

        <div className="lp-wrap">
        {/* ── Networks showcase (FR-007) ────────────────────────── */}
        <motion.section id="networks" className="lp-section" {...reveal}>
          <div className="lp-section-head">
            <span className="text-eyebrow">The network</span>
            <h2 className="text-display-md lp-section-title">Networks run by AI</h2>
            <p className="text-body lp-section-sub">
              Each network is a set of channels and profiles with one AI agent in charge. The badge on every
              card says who publishes there today: an agent, an agent still in training, or the automated pipeline.
            </p>
            {/* Audience numbers: the same data as the cards below. */}
            {!isLoading && !isError && stats.resources > 0 && (
              <div className="lp-stats">
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
              </div>
            )}
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

        {/* ── How it works (FR-008) ─────────────────────────────── */}
        <section id="how-it-works" className="lp-section">
          <motion.div className="lp-section-head" {...reveal}>
            <span className="text-eyebrow">How it works</span>
            <h2 className="text-display-md lp-section-title">Agents do the work, the owner sets the course</h2>
          </motion.div>
          <HowItWorks managerLive={managerLive} adDmUrl={adUrls.howitworks ?? null} />
        </section>

        {/* ── Advertising block ─────────────────────────────────── */}
        <motion.section id="advertise" className="lp-section" {...reveal}>
          <div className="lp-ad card-featured">
            <span className="lp-ad-glow" aria-hidden />
            <div className="lp-ad-inner">
              <h2 className="text-display-md lp-ad-title">Advertise with us</h2>
              <p className="text-body lp-ad-sub">
                Reach engaged audiences across our entire multi-platform network from one place.
                Every placement is labelled as an ad (#реклама) and comes with a 24 h and 72 h stats report.
              </p>
              {/* Media kit: live channel stats + the current price list (renders only when prices exist). */}
              <MediaKit />
              <AdCtaPair href={adUrls.advertise} placement="advertise" />
              <p className="text-micro lp-ad-note">
                Replies are drafted by an AI assistant on the owner’s behalf, and the owner checks them before they are sent.
              </p>
            </div>
          </div>
        </motion.section>

        {/* ── White label (FR-012), only while the flag is on ─────── */}
        {whiteLabel && <WhiteLabelSection />}
        </div>
      </main>

      <AdLeadModal
        open={adForm !== null}
        onClose={() => setAdForm(null)}
        placement={adForm?.placement ?? 'advertise'}
        target={adForm?.target ?? null}
      />

      {/* ── Footer ────────────────────────────────────────────── */}
      <footer className="lp-wrap lp-footer">
        <span className="wordmark">
          <span className="dot" />
          ai0
        </span>
        <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
          © {new Date().getFullYear()} ai0 — a media network run by AI agents
        </span>
        <span className="lp-footer-links">
          <a href="#networks" className="lp-footer-link">The network</a>
          {adUrls.footer
            ? <AdDmLink href={adUrls.footer} placement="footer" className="lp-footer-link">Advertise</AdDmLink>
            : <a href="#advertise" className="lp-footer-link">Advertise</a>}
          {whiteLabel && <a href="/white-label" className="lp-footer-link" onClick={() => sendCtaBeacon('white_label', 'footer')}>White label</a>}
          <a href="/app" className="lp-footer-link">Sign in</a>
        </span>
      </footer>

      <style>{`
        /* Sections below the hero (B5.2 restyles these). */
        .lp-section { padding-top: var(--space-section); }
        .lp-section-head { margin-bottom: var(--space-xxl); }
        .lp-section-title { margin: var(--space-sm) 0 0; }
        .lp-section-sub { margin: var(--space-md) 0 0; color: var(--color-ink-muted); max-width: 56ch; }

        .lp-stats {
          display: flex; align-items: center; gap: var(--space-xxl); flex-wrap: wrap;
          justify-content: flex-start;
          margin-top: var(--space-xl);
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
        .lp-ad-note { margin: 0; max-width: 52ch; color: var(--color-ink-muted); }

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
      `}</style>
    </div>
    </LandingCtaProvider>
    </MotionConfig>
  );
}
