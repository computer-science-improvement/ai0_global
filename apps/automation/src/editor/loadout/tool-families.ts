/**
 * Spec 065: tools that come with another tool. A document that web_fetch returns as an outline is read with read_doc and
 * find_in_doc, so an agent that has web_fetch has them — in the core set of a new loadout and in a stored custom one.
 */
export const TOOL_FAMILIES: Record<string, readonly string[]> = { web_fetch: ['read_doc', 'find_in_doc'] };

/** `names` plus the members of the families whose first tool is in it. */
export function withFamilies(names: readonly string[]): string[] {
  const out = new Set(names);
  for (const [first, rest] of Object.entries(TOOL_FAMILIES)) if (out.has(first)) rest.forEach((n) => out.add(n));
  return [...out];
}
