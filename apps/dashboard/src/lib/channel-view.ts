// Spec 078 C1: small pure helpers of the channel pages (names, the glyph letter, tracking-status copy).

export type TrackingStatus = 'ok' | 'not_subscribed' | 'unknown';

/**
 * Tracking-status presentation: a Badge tone and a label per state.
 * ok = the tracker is subscribed and polling; not_subscribed = the tracker must join before stats flow;
 * unknown = never resolved yet.
 */
export const TRACKING_META: Record<TrackingStatus, { label: string; tone: 'success' | 'warning' | 'neutral'; help: string }> = {
  ok:             { label: 'Tracking',       tone: 'success', help: 'Tracker is subscribed and polling this channel.' },
  not_subscribed: { label: 'Not subscribed', tone: 'warning', help: 'The tracker account isn’t subscribed — subscribe to start collecting stats.' },
  unknown:        { label: 'Unknown',        tone: 'neutral', help: 'Tracking state hasn’t been resolved yet.' },
};

/** The letter shown in a channel glyph: the first letter of the name, without a leading #, @ or -. */
export function channelInitial(name: string | null | undefined): string {
  return (name ?? '?').toString().replace(/^[#@-]/, '').trim().slice(0, 1).toUpperCase() || '?';
}

interface NameLike {
  title?: string | null;
  username?: string | null;
  channelKey?: string | null;
}

/** What a channel is called in a list or header: title, then channel key, then @username, then `fallback`. */
export function channelName(c: NameLike, fallback = '(no title)'): string {
  return c.title ?? c.channelKey ?? (c.username ? `@${c.username}` : fallback);
}
