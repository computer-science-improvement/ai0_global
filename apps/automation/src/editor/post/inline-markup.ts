/**
 * Markdown-lite → Telegram HTML. The model never writes HTML: everything is
 * escaped first, then exactly four constructs are turned into tags:
 *   **bold**   _italic_   [label](https://url)   ||spoiler||
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

const LINK_RE = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,2000})\)/g;

export function inlineToHtml(src: string): string {
  // Pull links out first so ** / _ inside URLs are never touched.
  const links: string[] = [];
  const withTokens = (src ?? '').replace(LINK_RE, (_m, label: string, url: string) => {
    links.push(`<a href="${escapeAttr(url)}">${escapeHtml(label)}</a>`);
    return `\u0000${links.length - 1}\u0000`;
  });

  let out = escapeHtml(withTokens)
    .replace(/\*\*([^*\n][^*]*?)\*\*/g, '<b>$1</b>')
    .replace(/\|\|([^|\n][^|]*?)\|\|/g, '<tg-spoiler>$1</tg-spoiler>')
    .replace(/(^|[\s(«"])_([^_\n]+?)_(?=$|[\s.,!?:;)»"])/g, '$1<i>$2</i>');

  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i) => links[Number(i)]);
  return out;
}

/** What the reader actually sees (for length limits and language checks). */
export function inlineToPlain(src: string): string {
  return (src ?? '')
    .replace(LINK_RE, '$1')
    .replace(/\*\*([^*]+?)\*\*/g, '$1')
    .replace(/\|\|([^|]+?)\|\|/g, '$1')
    .replace(/(^|[\s(«"])_([^_\n]+?)_(?=$|[\s.,!?:;)»"])/g, '$1$2');
}

/** Visible length of rendered Telegram HTML. */
export function visibleLength(html: string): number {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .length;
}
