import { useMediaQuery } from './useMediaQuery';

/**
 * True when the visitor asked the OS for reduced motion. CSS animations and transitions are already collapsed by the
 * global block at the end of index.css; this is for motion that CSS cannot reach: recharts animates in JS, so pass
 * `isAnimationActive={!reduced}` to every chart element.
 */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
