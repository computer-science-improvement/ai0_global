// html.ts — the one escaping helper for Telegram HTML parse_mode captions.
//
// Telegram's HTML mode only needs `&`, `<`, `>` escaped in text. Inside an
// attribute value (href="…") a `"` would also end the attribute early, so
// attribute values go through escapeAttr. Anything that lands in a caption
// from scraped data, a DB row, or a URL must pass through one of these; only
// model output that is *meant* to be HTML (and is validated as such) is
// inserted raw.

/** Escape text content for Telegram HTML (`&`, `<`, `>`). Null-safe. */
export function escapeHtml(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape an attribute value (e.g. an href): escapeHtml plus `"`. */
export function escapeAttr(s: string | null | undefined): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

/**
 * Drop a dangling, half-cut entity at the end of an escaped string (e.g. the
 * `&am` left when `&amp;` is sliced). Use after truncating escaped text.
 */
export function trimBrokenEntity(s: string): string {
  return s.replace(/&[#a-zA-Z0-9]{0,8}$/, '');
}
