// apps/automation/src/discovery/recommendations/recommendations.service.ts

/** Set-based Jaccard similarity. Inputs deduplicated; case-sensitive. */
export function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return inter / union;
}

export function scoreCandidate(
  target: { themes?: string[] },
  candidate: { themes?: string[] },
): number {
  return jaccardSimilarity(target.themes ?? [], candidate.themes ?? []);
}
