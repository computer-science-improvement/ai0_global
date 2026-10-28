// Spec 078 B5.2: "How to order an ad" — four step cards under a line that draws itself once as it scrolls into view.
// Replaces the ad row of the old HowItWorks. AD_STEPS is the single source of the copy (the legal ad label #реклама is
// the one allowed Cyrillic snippet, see lib/no-cyrillic-ui.test.ts). The CTA keeps the `howitworks` placement, so its
// clicks stay counted apart from the `advertise` button further down.
//
// The list item is the motion wrapper (entrance); the card inside it takes the hover lift, because motion leaves an inline
// `transform` on the element it animates and that would beat a hover transform.
import type { JSX } from 'react';
import { Icon, type IconName } from '../ui/Icon';
import { AdCtaPair, useLandingCta } from './cta';
import { DrawLine, Reveal } from './LandingMotion';

export interface AdStep { icon: IconName; title: string; body: string }

export const AD_STEPS: ReadonlyArray<AdStep> = [
  { icon: 'telegram', title: 'Message the AI ad manager', body: 'Write to our ad account in Telegram. The first message is prefilled for you, so just send it.' },
  { icon: 'calendar', title: 'Get prices and a slot', body: 'You get the current price list and agree on a format and a time slot.' },
  { icon: 'spend', title: 'Pay via LiqPay', body: 'Pay online through LiqPay once the slot and the creative are agreed.' },
  { icon: 'megaphone', title: 'Your post goes live', body: 'Published labelled #реклама (the legal ad label), with a stats report at 24 h and 72 h.' },
];

/** Disclosure under step 1: who writes the replies (the owner checks every one). */
export const AI_DISCLOSURE = 'Replies are drafted by an AI assistant on the owner’s behalf, and the owner checks them before they are sent. A human is available on request.';

export function AdSteps({ adDmUrl }: { adDmUrl: string | null }): JSX.Element {
  const { openAdForm } = useLandingCta();
  return (
    <div className="lp-adsteps" id="order-an-ad">
      <div className="lp-linetrack" aria-hidden="true"><DrawLine className="lp-linefill" /></div>
      <ol className="lp-adstep-list">
        {AD_STEPS.map((s, i) => (
          <Reveal as="li" key={s.title} className="lp-adstep-li" delay={i * 0.08} y={20}>
            <div className="lp-adstep">
              <div className="lp-adstep-top">
                <span className="lp-ico" aria-hidden="true"><Icon name={s.icon} size={18} /></span>
                <span className="lp-adstep-num mono" aria-hidden="true">0{i + 1}</span>
              </div>
              <h3 className="lp-adstep-title">{s.title}</h3>
              <p className="lp-adstep-body">{s.body}</p>
              {i === 0 && (
                <p className="lp-disclosure">
                  <Icon name="info" size={13} />
                  <span>{AI_DISCLOSURE}</span>
                </p>
              )}
            </div>
          </Reveal>
        ))}
      </ol>
      {(adDmUrl || openAdForm) && (
        <div className="lp-adcta">
          <AdCtaPair href={adDmUrl} placement="howitworks" />
          {adDmUrl && <span className="lp-adcta-note">Opens Telegram with your first message ready.</span>}
        </div>
      )}
    </div>
  );
}
