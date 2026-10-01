// Sponsor slot resolution shared by network-digest and topic-digest (spec 008 T006).
import { shortCampaign, withUtm } from '../../payments/ad-report';
import type { DigestSponsor } from '../../payments/digest-sponsors.repository';
import type { SponsorSlot } from './digest-format.util';

export interface ResolvedSponsor {
  slot:    SponsorSlot | null;
  /** Set when the slot comes from a paid ad order (marked published after the digest goes out). */
  orderId: string | null;
}

/**
 * A paid `digest_sponsor` order whose publish_at falls on this Kyiv day wins;
 * otherwise the static strategy param. Either way the link gets ai0 UTM tags
 * (campaign = short order id, or 'digest' for the static param). A lookup
 * failure never blocks the digest — it falls back to the static param.
 */
export async function resolveDigestSponsor(
  sponsors: { findForDay(channelKey: string, day: string): Promise<DigestSponsor | null> } | undefined,
  channelKey: string,
  kyivDay: string,
  fallback: SponsorSlot | null,
  warn: (msg: string) => void,
): Promise<ResolvedSponsor> {
  let paid: DigestSponsor | null = null;
  if (sponsors) {
    try { paid = await sponsors.findForDay(channelKey, kyivDay); }
    catch (err: any) { warn(`digest sponsor lookup failed: ${err?.message ?? err}`); }
  }
  if (paid) return { slot: { text: paid.text, url: withUtm(paid.url, shortCampaign(paid.orderId)) }, orderId: paid.orderId };
  if (fallback) return { slot: { text: fallback.text, url: withUtm(fallback.url, 'digest') }, orderId: null };
  return { slot: null, orderId: null };
}
