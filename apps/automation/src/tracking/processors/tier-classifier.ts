import { PollTier } from '../types';

export interface TierInput {
  postsLast7d:     number;
  daysSinceAdded?: number;
}

/**
 * Tier decision per spec:
 *   ≥ 3 posts/day   → hot
 *   0.5–3 posts/day → warm
 *   < 0.5 posts/day → cold
 * Brand-new channels (< 3 days of history) always classify as warm so they
 * get a fair polling cadence before being demoted to cold.
 */
export function classifyTier(input: TierInput): PollTier {
  if ((input.daysSinceAdded ?? Infinity) < 3) return 'warm';

  const perDay = input.postsLast7d / 7;
  if (perDay >= 3)   return 'hot';
  if (perDay >= 0.5) return 'warm';
  return 'cold';
}
