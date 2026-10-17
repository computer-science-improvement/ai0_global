/**
 * Spec 045: how much of one text another repeats — the longest run of consecutive words two texts share, in characters
 * (words joined by single spaces). Words are compared lowercase, punctuation ignored, so a copied sentence with other quotes
 * or emoji still counts. Linear in practice: runs start only where a two-word pair of `a` occurs in `b`.
 */

const WORD_RE = /[\p{L}\p{N}ʼ]+(?:-[\p{L}\p{N}ʼ]+)*/gu;

export function wordsOf(text: string): string[] {
  return [...text.toLowerCase().replace(/[’'`]/g, 'ʼ').matchAll(WORD_RE)].map((m) => m[0]);
}

export function commonRunChars(a: string, b: string): number {
  const x = wordsOf(a);
  const y = wordsOf(b);
  if (!x.length || !y.length) return 0;
  const at = new Map<string, number[]>();
  for (let j = 0; j + 1 < y.length; j++) {
    const k = `${y[j]} ${y[j + 1]}`;
    const list = at.get(k);
    if (list) list.push(j); else at.set(k, [j]);
  }
  let best = Math.max(...x.filter((w) => y.includes(w)).map((w) => w.length), 0);
  for (let i = 0; i + 1 < x.length; i++) {
    for (const j of at.get(`${x[i]} ${x[i + 1]}`) ?? []) {
      let n = 0;
      let chars = -1;
      while (i + n < x.length && j + n < y.length && x[i + n] === y[j + n]) { chars += x[i + n].length + 1; n++; }
      if (chars > best) best = chars;
    }
  }
  return best;
}

/** The longest run `text` shares with any of `sources`, with the source's index (-1 when nothing is shared). */
export function longestSharedRun(text: string, sources: readonly string[]): { chars: number; index: number } {
  let best = { chars: 0, index: -1 };
  sources.forEach((s, index) => {
    const chars = commonRunChars(text, s);
    if (chars > best.chars) best = { chars, index };
  });
  return best;
}
