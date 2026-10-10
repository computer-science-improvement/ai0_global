/**
 * Cheap near-duplicate signal: Dice coefficient over character trigrams of
 * normalized text. Good enough to catch "same story, reworded a little";
 * semantic repeats are the planner's job (it sees recent posts).
 */
export function normalizeForSimilarity(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/#[\p{L}\p{N}_]+/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function trigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 2; i++) {
    const g = t.slice(i, i + 3);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

export function similarity(a: string, b: string): number {
  const na = normalizeForSimilarity(a);
  const nb = normalizeForSimilarity(b);
  if (!na || !nb) return 0;
  const ta = trigrams(na);
  const tb = trigrams(nb);
  let inter = 0;
  let sizeA = 0;
  let sizeB = 0;
  for (const v of ta.values()) sizeA += v;
  for (const v of tb.values()) sizeB += v;
  for (const [g, v] of ta) inter += Math.min(v, tb.get(g) ?? 0);
  return (2 * inter) / (sizeA + sizeB);
}

export function topMatches<T extends { text: string }>(draft: string, corpus: T[], k = 5): Array<T & { score: number }> {
  return corpus
    .map((c) => ({ ...c, score: Math.round(similarity(draft, c.text) * 1000) / 1000 }))
    .sort((x, y) => y.score - x.score)
    .slice(0, k);
}

/**
 * Share of `a`'s character trigrams that also occur in `b` (0–1). For a short text (a news title) against
 * a longer one (a post): "is this story already told there?" — Dice punishes the length difference.
 */
export function containment(a: string, b: string): number {
  const na = normalizeForSimilarity(a);
  const nb = normalizeForSimilarity(b);
  if (!na || !nb) return 0;
  const ta = trigrams(na);
  const tb = trigrams(nb);
  let inter = 0;
  let size = 0;
  for (const [g, v] of ta) { size += v; inter += Math.min(v, tb.get(g) ?? 0); }
  return size ? inter / size : 0;
}
