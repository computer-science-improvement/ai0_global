import { bodyText, type IntegrityCheck } from '../types';

/** Words in the repeated run. */
export const VERBATIM_REPEAT_WORDS = 4;

const CYR = /\p{Script=Cyrillic}/u;

/**
 * The first run of `n` words that occurs twice (not overlapping) in a text, or null. Words are compared lowercase
 * with one apostrophe. A run needs at least n − 1 Cyrillic words of three letters or more: names and titles in
 * Latin («Out of Sight і TerraScape» in the lead and the body) are not a repeated thought.
 */
export function verbatimRepeat(text: string, n = VERBATIM_REPEAT_WORDS): string | null {
  const words = [...text.toLowerCase().replace(/[’'`]/g, 'ʼ').matchAll(/[\p{L}\p{N}ʼ]+(?:-[\p{L}\p{N}ʼ]+)*/gu)].map((m) => m[0]);
  const first = new Map<string, number>();
  for (let i = 0; i + n <= words.length; i++) {
    const run = words.slice(i, i + n);
    if (run.filter((w) => CYR.test(w) && [...w].length >= 3).length < n - 1) continue;
    const key = run.join(' ');
    const at = first.get(key);
    if (at === undefined) first.set(key, i);
    else if (i - at >= n) return key;
  }
  return null;
}

/**
 * Spec 037 T6: the same 4+-word sequence twice in one post (a repeated thought, OnePlus 16 13.10, is mostly the
 * critic's call; only the verbatim repeat is deterministic). A warning for the critic.
 */
export const verbatimRepeatCheck: IntegrityCheck = {
  id: 'verbatim-repeat',
  codes: ['verbatim_repeat'],
  run: (post) => {
    const run = verbatimRepeat(bodyText(post));
    return run ? [{ code: 'verbatim_repeat', level: 'warning' as const, message: 'ці слова повторюються в пості дослівно — скажи це один раз', excerpt: run }] : [];
  },
};
