import type { SlotFallback } from './fallback-ladder';

/**
 * Spec 037 T10: evergreen posts (the fallback ladder's last step, `story.kind = evergreen`; published_posts
 * strategy_type 'evergreen') are counted apart. The MANAGER's quality block shows their share of the week's written
 * posts per resource and flags it above 25 % — the channel lives off fillers because fresh sources run dry.
 */

export const EVERGREEN_SHARE_MAX = 0.25;

export interface EvergreenShare {
  /** Written posts of the window (published, shadowed, waiting for / approved by the owner). */
  posts:     number;
  evergreen: number;
  /** evergreen / posts; null without posts. */
  share:     number | null;
  /** share > 25 %. */
  over:      boolean;
}

export function evergreenShare(posts: number, evergreen: number): EvergreenShare {
  const share = posts > 0 ? Math.round((evergreen / posts) * 1000) / 1000 : null;
  return { posts, evergreen, share, over: share != null && share > EVERGREEN_SHARE_MAX };
}

/** A slot an evergreen post filled: the main post's failure reason (the ladder's first step), else null. */
export function evergreenFilled(fallback: SlotFallback | null | undefined): { reason: string } | null {
  const f = fallback?.final;
  if (!f || f.outcome !== 'rescued' || f.step !== 'evergreen') return null;
  return { reason: fallback!.steps[0]?.reason ?? 'the main post did not pass' };
}
