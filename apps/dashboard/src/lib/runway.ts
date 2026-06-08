/** Strategy types that draw from a finite, pre-loaded content pool. */
export const FINITE_POOL_TYPES = new Set<string>([
  'recipes', 'quotes', 'facts', 'curated-prompts',
  'ai0-prompts', 'pdr-quiz', 'motivation-biography', 'assets',
]);

/** True when a finite-pool strategy's remaining supply is below its threshold. */
export function isLowContent(s: { content_remaining: number | null; low_content_threshold: number }): boolean {
  return s.content_remaining != null && s.content_remaining < s.low_content_threshold;
}
