// Spec 026 FR-012/FR-013: the public white-label page. English only (owner decision
// 2026-10-06). Shown only while the white-label flag is on; otherwise the page says the
// offer is temporarily unavailable (and the API refuses white-label requests with 403).
// Honest about delivery: a separate deployment per client today (single-tenant).
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, type JSX } from 'react';
import { useLandingPublicConfig, useLandingPulse } from '../api/landing';
import { ProofStrip } from '../components/landing/ProofStrip';
import { LeadFormStyles, WhiteLabelForm } from '../components/landing/LeadForms';
import { SingleTenantNote, WhiteLabelFeatures, WhiteLabelStyles } from '../components/landing/WhiteLabel';
import { Icon } from '../components/ui/Icon';
import { whiteLabelVisible } from '../lib/lead-form';
import { SHARED_PLATFORM_NEEDS, WHITE_LABEL_FAQ, WHITE_LABEL_PITCH } from '../lib/white-label-copy';

export const Route = createFileRoute('/white-label')({ component: WhiteLabelPage });

const ROLLOUT = [
  { title: 'A short call', body: 'We look at your channels and profiles, how you publish today and what you want the agents to do.' },
  { title: 'Your own deployment', body: 'We set up a separate ai0 for you: your database, keys, bot and platform accounts. Nothing is shared with other clients.' },
  { title: 'Shadow period', body: 'The agents plan and write next to your current setup. You compare, give feedback, and decide channel by channel.' },
  { title: 'Live, with you in charge', body: 'Agents publish; the MANAGER reports on the whole network; structural changes still come to you as cards to approve.' },
];

function WhiteLabelPage(): JSX.Element {
  const config = useLandingPublicConfig();
  const pulse = useLandingPulse();
  const visible = whiteLabelVisible(config.data);

  useEffect(() => {
    const prev = document.title;
    document.title = 'White label · ai0 — AI agents for your own channels';
    return () => { document.title = prev; };
  }, []);

  return (
    <div className="wl-root">
      <header className="wl-topbar">
        <a href="/" className="wordmark" aria-label="ai0 home"><span className="dot" />ai0</a>
        <nav className="wl-nav">
          <a href="/" className="wl-nav-link">The network</a>
          {visible && <a href="#request" className="wl-nav-link wl-nav-cta">Request a setup</a>}
        </nav>
      </header>

      <main className="wl-main">
        {config.isLoading && <div className="wl-loading" aria-busy="true">Loading…</div>}

        {!config.isLoading && !visible && (
          <section className="wl-unavailable" aria-labelledby="wl-off-title">
            <span className="wl-unavailable-icon" aria-hidden><Icon name="clock" size={22} /></span>
            <h1 id="wl-off-title" className="text-display-md">The white-label offer is temporarily unavailable</h1>
            <p className="text-body wl-muted">
              {config.isError ? 'We couldn’t load this page right now. Please try again in a few minutes.' : 'Please check back later. Meanwhile, you can see the network the agents run today.'}
            </p>
            <a href="/" className="lf-btn">See the ai0 network</a>
          </section>
        )}

        {visible && (
          <>
            <section className="wl-hero">
              <span className="text-eyebrow">White label</span>
              <h1 className="text-display-xl wl-title">The ai0 agents, for your own channels</h1>
              <p className="text-subhead wl-sub">{WHITE_LABEL_PITCH} You keep your data and accounts; the agents do the planning and writing, and you approve what matters.</p>
              <div className="wl-hero-cta">
                <a href="#request" className="lf-btn">Request a white-label setup <span aria-hidden>↓</span></a>
                <a href="/" className="wl-ghost">See the network they run</a>
              </div>
              {!pulse.isError && pulse.data && (
                <div className="wl-proof">
                  <p className="wl-proof-label">Live from the ai0 network, last 7 days</p>
                  <ProofStrip pulse={pulse.data} />
                </div>
              )}
            </section>

            <section className="wl-section" aria-labelledby="wl-what">
              <h2 id="wl-what" className="text-display-md wl-h2">What you get</h2>
              <WhiteLabelFeatures />
            </section>

            <section className="wl-section" aria-labelledby="wl-how">
              <h2 id="wl-how" className="text-display-md wl-h2">How it is delivered</h2>
              <ol className="wl-steps">
                {ROLLOUT.map((s, i) => (
                  <li key={s.title} className="wl-step">
                    <span className="wl-step-n" aria-hidden>{i + 1}</span>
                    <span className="wl-step-title">{s.title}</span>
                    <span className="wl-step-body">{s.body}</span>
                  </li>
                ))}
              </ol>
              <SingleTenantNote />
            </section>

            <section className="wl-section" aria-labelledby="wl-faq">
              <h2 id="wl-faq" className="text-display-md wl-h2">Questions</h2>
              <div className="wl-faq">
                {WHITE_LABEL_FAQ.map((f) => (
                  <details key={f.q} className="wl-faq-item">
                    <summary>{f.q}<Icon name="chevron-down" size={16} /></summary>
                    <p>{f.a}</p>
                  </details>
                ))}
                <details className="wl-faq-item">
                  <summary>What would a shared, multi-client platform need?<Icon name="chevron-down" size={16} /></summary>
                  <div>
                    <p>None of this exists yet; it is the work a shared cabinet for several clients would take:</p>
                    <ul className="wl-needs">
                      {SHARED_PLATFORM_NEEDS.map((n) => <li key={n}>{n}</li>)}
                    </ul>
                  </div>
                </details>
              </div>
            </section>

            <section id="request" className="wl-section wl-form-section" aria-labelledby="wl-request">
              <h2 id="wl-request" className="text-display-md wl-h2">Request a white-label setup</h2>
              <p className="text-body wl-muted">Tell us about your resources, and we will reply to arrange a short call. Fields marked * are required.</p>
              <div className="wl-form-card">
                <WhiteLabelForm />
              </div>
            </section>
          </>
        )}
      </main>

      <footer className="wl-footer">
        <span className="text-micro wl-muted">© {new Date().getFullYear()} ai0 — a media network run by AI agents</span>
        <a href="/" className="wl-nav-link">Back to the network</a>
      </footer>

      <WhiteLabelStyles />
      <LeadFormStyles />
      <style>{`
        .wl-root { min-height: 100vh; display: flex; flex-direction: column; background: var(--color-canvas); color: var(--color-ink); overflow-x: clip; }
        .wl-topbar, .wl-main, .wl-footer { width: 100%; max-width: 1080px; margin: 0 auto; padding-left: var(--space-xl); padding-right: var(--space-xl); }
        .wl-topbar { display: flex; align-items: center; justify-content: space-between; padding-top: var(--space-xl); padding-bottom: var(--space-xl); }
        .wl-topbar .wordmark { font-size: 16px; text-decoration: none; color: var(--color-ink); }
        .wl-nav { display: flex; align-items: center; gap: var(--space-xs); }
        .wl-nav-link {
          color: var(--color-ink-muted); text-decoration: none; font-size: 14px; font-weight: 500;
          padding: 10px 14px; border-radius: var(--radius-sm); min-height: 40px; display: inline-flex; align-items: center;
        }
        .wl-nav-link:hover { color: var(--color-ink); background: var(--color-surface-2); opacity: 1; }
        .wl-nav-link:focus-visible, .wl-ghost:focus-visible, .lf-btn:focus-visible, .wl-faq-item summary:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
        .wl-nav-cta { color: var(--color-accent); }
        .wl-main { flex: 1; }
        .wl-loading { padding: var(--space-section) 0; color: var(--color-ink-muted); text-align: center; }
        .wl-muted { color: var(--color-ink-muted); }
        .wl-unavailable { display: flex; flex-direction: column; align-items: center; text-align: center; gap: var(--space-lg); padding: var(--space-section) 0; }
        .wl-unavailable h1 { margin: 0; max-width: 22ch; }
        .wl-unavailable p { margin: 0; max-width: 52ch; }
        .wl-unavailable-icon { display: inline-flex; width: 48px; height: 48px; align-items: center; justify-content: center; border-radius: 50%; background: var(--color-warning-soft); color: var(--color-warning); }
        .wl-hero { display: flex; flex-direction: column; align-items: center; text-align: center; padding: var(--space-section) 0 var(--space-xxl); }
        .wl-title { margin: var(--space-sm) 0 0; max-width: 16ch; }
        .wl-sub { margin: var(--space-xl) 0 0; max-width: 60ch; color: var(--color-ink-muted); }
        .wl-hero-cta { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: var(--space-lg); margin-top: var(--space-xxl); }
        .wl-ghost {
          display: inline-flex; align-items: center; min-height: 44px; padding: 12px 22px; border-radius: var(--radius-sm);
          color: var(--color-ink-muted); border: 1px solid var(--color-hairline-strong); text-decoration: none; font-size: 15px; font-weight: 500;
        }
        .wl-ghost:hover { color: var(--color-ink); background: var(--color-surface-2); opacity: 1; }
        .wl-proof { width: 100%; margin-top: var(--space-xxl); }
        .wl-proof-label { margin: 0; font-size: 13px; color: var(--color-ink-muted); }
        .wl-section { padding-top: var(--space-section); }
        .wl-h2 { margin: 0 0 var(--space-xl); }
        .wl-steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--space-lg); }
        @media (max-width: 900px) { .wl-steps { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 560px) { .wl-steps { grid-template-columns: 1fr; } }
        .wl-step { display: flex; flex-direction: column; gap: var(--space-sm); padding: var(--space-xl); background: var(--color-surface-1); border: 1px solid var(--color-hairline-soft); border-radius: var(--radius-lg); }
        .wl-step-n { display: inline-flex; width: 28px; height: 28px; align-items: center; justify-content: center; border-radius: 50%; background: var(--color-surface-2); border: 1px solid var(--color-hairline); color: var(--color-accent); font-size: 13px; font-weight: 600; }
        .wl-step-title { font-weight: 600; font-size: 15px; }
        .wl-step-body { font-size: 14px; line-height: 1.55; color: var(--color-ink-muted); }
        .wl-faq { display: flex; flex-direction: column; gap: var(--space-sm); max-width: 820px; }
        .wl-faq-item { background: var(--color-surface-1); border: 1px solid var(--color-hairline-soft); border-radius: var(--radius-md); }
        .wl-faq-item summary {
          display: flex; justify-content: space-between; align-items: center; gap: var(--space-md);
          padding: 14px 18px; min-height: 48px; cursor: pointer; list-style: none; font-weight: 600; font-size: 15px;
        }
        .wl-faq-item summary::-webkit-details-marker { display: none; }
        .wl-faq-item summary svg { flex-shrink: 0; color: var(--color-ink-muted); transition: transform 0.2s ease; }
        .wl-faq-item[open] summary svg { transform: rotate(180deg); }
        @media (prefers-reduced-motion: reduce) { .wl-faq-item summary svg { transition: none; } }
        .wl-faq-item p, .wl-faq-item > div { margin: 0; padding: 0 18px 16px; font-size: 15px; line-height: 1.6; color: var(--color-ink-muted); }
        .wl-faq-item > div p { padding: 0 0 8px; }
        .wl-needs { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; }
        .wl-form-section > p { margin: 0 0 var(--space-xl); max-width: 60ch; }
        .wl-form-card { max-width: 820px; padding: var(--space-xl); background: var(--color-surface-1); border: 1px solid var(--color-hairline); border-radius: var(--radius-xl); }
        .wl-footer { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-lg); margin-top: var(--space-section); padding-top: var(--space-xl); padding-bottom: var(--space-xl); border-top: 1px solid var(--color-hairline); }
        @media (max-width: 600px) {
          .wl-topbar, .wl-main, .wl-footer { padding-left: var(--space-lg); padding-right: var(--space-lg); }
          .wl-hero { padding-top: var(--space-xxl); }
          .wl-form-card { padding: var(--space-lg); }
          .wl-step { padding: var(--space-lg); }
        }
      `}</style>
    </div>
  );
}
