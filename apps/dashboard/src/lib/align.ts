// Spec 062 FR-008: "Resolve in one card" is the `/align` slash command (the server runs it in code, no model turn), and the
// card it proposes lists its items in the chat bubble.

/** The composer prefill that resolves an agent's config conflicts: `/align @handle`. */
export function alignPrompt(handle: string): string {
  return `/align @${handle.replace(/^@+/, '')}`;
}

/** The first `max` lines of a resolver card's items (their details), and how many more there are. */
export function resolverItemLines(payload: unknown, max = 3): { lines: string[]; more: number } {
  const items = payload && typeof payload === 'object' && Array.isArray((payload as { items?: unknown }).items)
    ? ((payload as { items: unknown[] }).items)
    : [];
  const details = items
    .map((it) => (it && typeof it === 'object' ? (it as { detail?: unknown }).detail : null))
    .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
    .map((d) => d.replace(/\s+/g, ' ').trim());
  return { lines: details.slice(0, max), more: Math.max(0, details.length - max) };
}
