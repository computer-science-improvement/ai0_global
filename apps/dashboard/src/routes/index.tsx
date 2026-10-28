import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { MotionConfig } from 'motion/react';
import { Icon } from '../components/ui/Icon';
import { NetworkShowcase } from '../components/landing/NetworkShowcase';
import { MediaKit } from '../components/landing/MediaKit';
import { ProofStrip } from '../components/landing/ProofStrip';
import { HeroHeadline } from '../components/landing/HeroHeadline';
import { HeroOrbit } from '../components/landing/HeroOrbit';
import { AgentLog } from '../components/landing/AgentLog';
import { ChannelMarquee } from '../components/landing/ChannelMarquee';
import { CountUp } from '../components/landing/CountUp';
import { RoleExplorer } from '../components/landing/RoleExplorer';
import { GuardTrack, LoopRing } from '../components/landing/LoopRing';
import { ApprovalDeck, ApprovalModes } from '../components/landing/ApprovalDeck';
import { AdSteps } from '../components/landing/AdSteps';
import { Muted, SectionHead } from '../components/landing/SectionHead';
import { LoopScope, Reveal } from '../components/landing/LandingMotion';
import '../components/landing/landing.css';
import '../components/landing/landing-sections.css';
import { AdCtaPair, AdDmLink, LandingCtaProvider, NoTelegramLink, sendCtaBeacon, type LandingCtaApi } from '../components/landing/cta';
import { AdLeadModal } from '../components/landing/LeadForms';
import { WhiteLabelSection } from '../components/landing/WhiteLabel';
import { whiteLabelVisible } from '../lib/lead-form';
import type { LandingPlacement } from '../api/landing';
import { useLandingNetworks, useLandingPublicConfig, useLandingPulse } from '../api/landing';
import { audienceStats, heroLivePill, heroPlatforms, networkHeadline } from '../lib/landing-view';

export const Route = createFileRoute('/')({ component: LandingPage });

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
  const headline = networkHeadline(networks);

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

        {/* ── How it works (FR-008): who runs the network ───────── */}
        <LoopScope as="section" id="how-it-works" className="lp-band" aria-labelledby="how-title">
          <div className="lp-wrap">
            <Reveal>
              <SectionHead
                eyebrow="How it works"
                id="how-title"
                title={<>Agents do the work,<br /><Muted>the owner sets the course.</Muted></>}
                lead="Pick a role to see what it does and who it reports to."
              />
            </Reveal>
            <Reveal delay={0.05}>
              <RoleExplorer pulse={livePulse} platforms={platforms} />
            </Reveal>
            <p className="lp-foot">
              <Icon name="lock" size={13} />
              Structural decisions are approved by the owner. During the launch period the owner also approves each post before it goes out.
            </p>
          </div>
        </LoopScope>

        {/* ── The loop and the guards ───────────────────────────── */}
        <LoopScope as="section" className="lp-band is-alt" aria-labelledby="loop-title">
          <div className="lp-wrap">
            <div className="lp-loopgrid">
              <Reveal className="lp-ring-col">
                <LoopRing />
              </Reveal>
              <Reveal className="lp-head-col" delay={0.05}>
                <SectionHead
                  eyebrow="The loop"
                  id="loop-title"
                  title={<>Plan, write, guard, publish.<br /><Muted>Then learn.</Muted></>}
                  lead="The Reviewer measures how every post performed and feeds the lessons back into planning, so tomorrow’s plan starts from what actually worked."
                />
              </Reveal>
            </div>
            <Reveal className="lp-guard">
              <div className="lp-guard-head">
                <h3 className="lp-guard-title">Code guards on every post</h3>
                <span className="lp-guard-sub mono">The Executor publishes only after every gate passes</span>
              </div>
              <GuardTrack />
            </Reveal>
          </div>
        </LoopScope>

        {/* ── Human in the loop ─────────────────────────────────── */}
        <LoopScope as="section" className="lp-band" aria-labelledby="human-title">
          <div className="lp-wrap">
            <div className="lp-human">
              <Reveal className="lp-human-copy">
                <SectionHead
                  eyebrow="Human in the loop"
                  tone="warning"
                  id="human-title"
                  title={<>You approve<br />what matters.</>}
                  lead="Structural changes always wait for the owner. During the launch period every post waits too: from 20:00 the agents write most of tomorrow’s posts, and you clear them in one pass."
                />
                <ApprovalModes />
              </Reveal>
              <ApprovalDeck />
            </div>
          </div>
        </LoopScope>

        {/* ── Networks showcase (FR-007) ────────────────────────── */}
        <LoopScope as="section" id="networks" className="lp-band is-alt" aria-labelledby="networks-title">
          <div className="lp-wrap">
            <div className="lp-net-top">
              <Reveal className="lp-head-col">
                <SectionHead
                  eyebrow="Networks run by AI"
                  id="networks-title"
                  title={<>{headline.lead}{headline.rest && <><br /><Muted>{headline.rest}</Muted></>}</>}
                  lead="Each network is a set of channels and profiles with one AI agent in charge. The badge on every card says who publishes there today: an agent, an agent still in training, or the automated pipeline."
                />
              </Reveal>
              {/* Audience numbers: the same data as the cards below. */}
              {!isLoading && !isError && stats.resources > 0 && (
                <div className="lp-counts">
                  <span className="lp-stat">
                    <CountUp to={stats.followers} />
                    <span className="lp-stat-label">followers reached</span>
                  </span>
                  <span className="lp-stat">
                    <CountUp to={stats.resources} />
                    <span className="lp-stat-label">channels &amp; profiles</span>
                  </span>
                  <span className="lp-stat">
                    <CountUp to={stats.platforms} />
                    <span className="lp-stat-label">platforms</span>
                  </span>
                </div>
              )}
            </div>

            <div className="lp-net-body">
              {isLoading && (
                <div className="lp-skeleton-grid" aria-busy="true">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="lp-skeleton" />
                  ))}
                </div>
              )}

              {isError && !isLoading && (
                <div className="callout-warning lp-net-error">
                  <Icon name="warning" size={16} />
                  <span>Couldn’t load the showcase right now. Please try again shortly.</span>
                </div>
              )}

              {!isLoading && !isError && <NetworkShowcase networks={networks ?? []} />}
            </div>
          </div>
        </LoopScope>

        {/* ── Advertising block ─────────────────────────────────── */}
        <section id="advertise" className="lp-band" aria-labelledby="advertise-title">
          <div className="lp-wrap">
            <Reveal>
              <SectionHead
                eyebrow="Advertise"
                id="advertise-title"
                title={<>Your post, in front<br /><Muted>of the whole network.</Muted></>}
                lead="Reach engaged audiences across our entire multi-platform network from one place. Every placement is labelled as an ad and comes with a 24 h and 72 h stats report."
              />
            </Reveal>
            <AdSteps adDmUrl={adUrls.howitworks ?? null} />
            {/* Media kit: live channel stats + the current price list (renders only when prices exist). */}
            <div className="lp-ad-kit">
              <MediaKit />
            </div>
            <div className="lp-ad-final">
              <AdCtaPair href={adUrls.advertise} placement="advertise" />
              <p className="lp-ad-note">
                Replies are drafted by an AI assistant on the owner’s behalf, and the owner checks them before they are sent.
              </p>
            </div>
          </div>
        </section>

        {/* ── White label (FR-012), only while the flag is on ─────── */}
        {whiteLabel && <WhiteLabelSection />}

        {/* ── Closing call to action ────────────────────────────── */}
        <LoopScope as="section" className="lp-final" aria-label="Get started">
          <div className="lp-wrap">
            <Reveal>
              <div className="lp-bigword" aria-hidden="true"><span className="lp-bigdot" />ai0</div>
              <h2 className="lp-h2">Let agents run the routine.<br /><Muted>Keep the decisions.</Muted></h2>
              <div className="lp-final-ctas">
                <a href="/app" className="lp-hero-cta-primary">Sign in</a>
                <a href="#advertise" className="lp-hero-cta-secondary">Advertise with us</a>
              </div>
            </Reveal>
          </div>
        </LoopScope>
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
        <span className="lp-footer-copy">
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
    </div>
    </LandingCtaProvider>
    </MotionConfig>
  );
}
