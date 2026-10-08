// Spec 026 FR-009: the landing's ad CTAs. Every "Order an ad in Telegram" link is a
// plain <a target="_blank" rel="noopener"> to the server-built t.me link (the page
// has no template logic); a click also sends an anonymous beacon to
// POST /api/landing/cta ({cta, placement, lang}: no visitor data).
//
// The tracking lives in a context so the shared components (NetworkShowcase,
// HowItWorks, MediaKit) count clicks on the public page only: the admin live
// preview renders them without a provider, and its clicks are never counted.
import { createContext, useContext, type JSX, type ReactNode } from 'react';
import type { LandingPlacement } from '../../api/landing';
import { API_BASE } from '../../lib/env';
import { Icon } from '../ui/Icon';

export type LandingCta = 'ad_dm' | 'ad_form' | 'white_label';

/** Fire-and-forget click counter. sendBeacon survives the tab switching to Telegram. */
export function sendCtaBeacon(cta: LandingCta, placement: LandingPlacement): void {
  try {
    const body = JSON.stringify({ cta, placement, lang: 'en' });
    const url = `${API_BASE}/api/landing/cta`;
    const blob = new Blob([body], { type: 'application/json' });
    if (typeof navigator !== 'undefined' && navigator.sendBeacon?.(url, blob)) return;
    void fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => undefined);
  } catch { /* a lost click never breaks the page */ }
}

export interface LandingCtaApi {
  /** Count a CTA click (no-op outside the public page). */
  track: (cta: LandingCta, placement: LandingPlacement) => void;
  /**
   * Open the "no Telegram" ad request form with the target prefilled (spec 026 FR-011).
   * Null where the form is not available (the admin preview).
   */
  openAdForm: ((input: { placement: LandingPlacement; target?: string | null }) => void) | null;
}

const NOOP: LandingCtaApi = { track: () => undefined, openAdForm: null };
const Ctx = createContext<LandingCtaApi>(NOOP);

export function LandingCtaProvider({ value, children }: { value: LandingCtaApi; children: ReactNode }): JSX.Element {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLandingCta(): LandingCtaApi {
  return useContext(Ctx);
}

/** The Telegram DM link of one placement. Opens in a new tab and counts the click. */
export function AdDmLink({ href, placement, className, children, ariaLabel }: {
  href: string; placement: LandingPlacement; className?: string; children: ReactNode; ariaLabel?: string;
}): JSX.Element {
  const { track } = useLandingCta();
  return (
    <a href={href} target="_blank" rel="noopener" className={className} aria-label={ariaLabel} onClick={() => track('ad_dm', placement)}>
      {children}
    </a>
  );
}

/** "No Telegram? Leave a request" next to a DM CTA; renders nothing where the form is unavailable. */
export function NoTelegramLink({ placement, target, className }: {
  placement: LandingPlacement; target?: string | null; className?: string;
}): JSX.Element | null {
  const { track, openAdForm } = useLandingCta();
  if (!openAdForm) return null;
  return (
    <button
      type="button"
      className={className ?? 'lp-notg'}
      onClick={() => { track('ad_form', placement); openAdForm({ placement, target }); }}
    >
      No Telegram? Leave a request
    </button>
  );
}

/** The pair most placements use: the DM button plus the form link under it. */
export function AdCtaPair({ href, placement, target, label = 'Order an ad in Telegram', className = 'lp-hero-cta-primary' }: {
  href: string | null | undefined; placement: LandingPlacement; target?: string | null; label?: string; className?: string;
}): JSX.Element {
  return (
    <span className="lp-cta-pair">
      {href && (
        <AdDmLink href={href} placement={placement} className={className}>
          <Icon name="telegram" size={15} /> {label}
        </AdDmLink>
      )}
      <NoTelegramLink placement={placement} target={target} />
    </span>
  );
}
