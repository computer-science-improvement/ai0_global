import { z } from 'zod';

/** What a free-text argument ends with when it was longer than its limit (spec 064 FR-003). */
export const CLIP_MARK = ' …(скорочено)';

/** `s` cut to at most `max` characters, ending with CLIP_MARK when it was longer. */
export function clipLong(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - CLIP_MARK.length)).trimEnd()}${CLIP_MARK}`;
}

/**
 * Spec 064 FR-003: a free-text argument that is too long is cut, not rejected — a rejection costs a turn and a planner
 * on its last one never recovers. The limit is stated in the tool description (`longTextNote`), since the JSON schema
 * of a transformed string no longer carries `maxLength`.
 */
export function longText(min: number, max: number) {
  return z.string().min(min).transform((s) => clipLong(s, max));
}

/** The sentence for a field's description that tells the model the limit (the text is cut, not refused). */
export const longTextNote = (max: number) => `до ${max} символів, довше буде обрізано`;
