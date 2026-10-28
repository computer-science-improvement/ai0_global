// Spec 026 FR-012: the white-label offer. `WhiteLabelSection` is the #white-label block
// on the landing; the full page (/white-label) reuses its feature cards and the same
// single-tenant statement. Both are rendered only while the white-label flag is on.
import type { JSX } from 'react';
import { Icon, type IconName } from '../ui/Icon';
import { SINGLE_TENANT_STATEMENT, WHITE_LABEL_PITCH } from '../../lib/white-label-copy';
import { useLandingCta } from './cta';
import { LoopScope, Reveal } from './LandingMotion';
import { Muted, SectionHead } from './SectionHead';
import { ShadowLiveDemo } from './ShadowLiveDemo';

export interface WlFeature { icon: IconName; title: string; body: string }

export const WL_FEATURES: WlFeature[] = [
  { icon: 'agents', title: 'Agents for your resources', body: 'An orchestrator per network or channel, with planner, executor and reviewer roles, set up for your own channels and profiles.' },
  { icon: 'eye', title: 'Shadow first', body: 'Every agent starts in shadow: it plans and writes next to your current setup, and you switch a channel over only when you trust it.' },
  { icon: 'radar', title: 'MANAGER and a KPI digest', body: 'A MANAGER agent reads the numbers of your whole network and turns them into directives or advice, which you approve.' },
  { icon: 'megaphone', title: 'Ad tooling', body: 'A price list, an AI-drafted reply to every ad request, LiqPay payments, posts labelled as ads, and reports at 24 and 72 hours.' },
  { icon: 'check', title: 'Owner cards', body: 'Structural decisions come to you as cards to approve or decline. During the launch period you also approve each post.' },
  { icon: 'lock', title: 'Guard rails in code', body: 'Dedup, rate limits, quiet hours, AI budgets and a kill switch are enforced by code, not left to the model.' },
];

/** The delivery block: the honest single-tenant statement (FR-012). */
export function SingleTenantNote(): JSX.Element {
  return (
    <div className="wl-delivery" role="note" aria-label="How white label is delivered today">
      <span className="wl-delivery-icon" aria-hidden><Icon name="database" size={17} /></span>
      <p className="wl-delivery-text">{SINGLE_TENANT_STATEMENT}</p>
    </div>
  );
}

/**
 * The feature cards. `/white-label` shows all six; the landing section shows `titles` (in that order), because "Shadow
 * first" is the demo above them and the delivery is the single-tenant note below.
 */
export function WhiteLabelFeatures({ limit, titles }: { limit?: number; titles?: readonly string[] }): JSX.Element {
  const list = titles
    ? titles.flatMap((t) => WL_FEATURES.filter((f) => f.title === t))
    : WL_FEATURES.slice(0, limit ?? WL_FEATURES.length);
  return (
    <ul className="wl-features">
      {list.map((f) => (
        <li key={f.title} className="wl-feature">
          <span className="wl-feature-icon" aria-hidden><Icon name={f.icon} size={17} /></span>
          <span className="wl-feature-title">{f.title}</span>
          <span className="wl-feature-body">{f.body}</span>
        </li>
      ))}
    </ul>
  );
}

/** The three cards of the landing section ("Shadow first" is the demo, the delivery is the note). */
export const LANDING_WL_TITLES = ['Agents for your resources', 'MANAGER and a KPI digest', 'Guard rails in code'] as const;

/** #white-label on the landing: the offer in short, the shadow/live demo, the delivery note and a link to /white-label. */
export function WhiteLabelSection(): JSX.Element {
  const { track } = useLandingCta();
  return (
    // A LoopScope: the demo lanes loop, and they pause while the section is off screen.
    <LoopScope as="section" id="white-label" className="lp-band is-alt lp-wl" aria-labelledby="white-label-title">
      <div className="lp-wrap">
        <Reveal>
          <SectionHead
            eyebrow="White label"
            id="white-label-title"
            title={<>Run your own network<br /><Muted>with AI agents.</Muted></>}
            lead={WHITE_LABEL_PITCH}
          />
        </Reveal>
        <Reveal className="lp-wl-demo">
          <ShadowLiveDemo />
        </Reveal>
        <Reveal>
          <WhiteLabelFeatures titles={LANDING_WL_TITLES} />
        </Reveal>
        <SingleTenantNote />
        <div className="wl-cta">
          <a href="/white-label" className="lp-hero-cta-primary" onClick={() => track('white_label', 'whitelabel')}>
            See the white-label offer <span aria-hidden>→</span>
          </a>
        </div>
      </div>
      <WhiteLabelStyles />
    </LoopScope>
  );
}

export function WhiteLabelStyles(): JSX.Element {
  return (
    <style>{`
      .wl-features { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-lg); }
      @media (max-width: 900px) { .wl-features { grid-template-columns: repeat(2, 1fr); } }
      @media (max-width: 560px) { .wl-features { grid-template-columns: 1fr; } }
      .wl-feature {
        display: flex; flex-direction: column; gap: var(--space-sm); padding: var(--space-xl); min-width: 0;
        background: var(--color-surface-1); border: 1px solid var(--color-hairline-soft); border-radius: var(--radius-lg);
      }
      .wl-feature-icon {
        display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 38px;
        border-radius: var(--radius-md); background: var(--color-surface-2); border: 1px solid var(--color-hairline);
        color: var(--color-accent); margin-bottom: var(--space-xs);
      }
      .wl-feature-title { font-size: 15px; font-weight: 600; color: var(--color-ink); }
      .wl-feature-body { font-size: 14px; line-height: 1.55; color: var(--color-ink-muted); }
      .wl-delivery {
        display: flex; gap: var(--space-md); align-items: flex-start; margin-top: var(--space-xl);
        padding: var(--space-lg) var(--space-xl); border-radius: var(--radius-lg);
        background: var(--color-surface-2); border: 1px solid var(--color-hairline);
      }
      .wl-delivery-icon { color: var(--color-accent); flex-shrink: 0; margin-top: 2px; }
      .wl-delivery-text { margin: 0; font-size: 15px; line-height: 1.6; color: var(--color-ink); max-width: 75ch; }
      .wl-cta { display: flex; justify-content: center; margin-top: var(--space-xxl); }
      @media (max-width: 600px) { .wl-feature, .wl-delivery { padding: var(--space-lg); } }
    `}</style>
  );
}
