/**
 * Removes stray Markdown leaks the AI may emit despite explicit "no markdown"
 * instructions. Telegram is configured for HTML parse mode, so any `**bold**` or
 * `_italic_` would render literally.
 *
 * Conservative: only strips the markdown wrappers; keeps the inner text. Does not
 * touch HTML tags, URLs, or mid-word asterisks (rare but possible in code-style
 * tokens like `C*`).
 */
export function stripStrayMarkdown(s: string): string {
  return s
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, '$1')
    .replace(/^[ \t]*-{3,}[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Strips common preambles models add despite explicit "no preamble" rules:
 * "Пост:", "Ось готовий пост:", "**Готовий пост:**", "<b>Готовий пост:</b>",
 * code fences, etc. Same regex set used previously inside PostGenerationAgent.
 */
export function stripPreambles(raw: string): string {
  return raw
    .replace(
      /^\s*(?:\*\*|__|<b>|<strong>)\s*(Ось\s+)?(готов(ий|ого)\s+)?пост\s*[:：]?\s*(?:\*\*|__|<\/b>|<\/strong>)\s*$/gim,
      '',
    )
    .replace(
      /^\s*(?:\*\*|__|<b>|<strong>)\s*final\s+post\s*[:：]?\s*(?:\*\*|__|<\/b>|<\/strong>)\s*$/gim,
      '',
    )
    .replace(/^\s*(Ось\s+)?(готов(ий|ого)\s+)?пост\s*[:：]\s*$/gim, '')
    .replace(/^\s*final\s+post\s*[:：]\s*$/gim, '')
    .replace(/^```(?:json|markdown|html|text)?\s*\n/i, '')
    .replace(/\n```\s*$/i, '')
    .trim();
}

/**
 * Full final-text cleanup pipeline applied to the AI's response before publishing.
 * Combines preamble stripping + stray-markdown removal. Order matters: preambles
 * first (so their bold/HTML wrappers are removed before we try to strip standalone
 * bold), then markdown.
 */
export function cleanFinalText(raw: string): string {
  const noPreamble = stripPreambles(raw);
  const noMarkdown = stripStrayMarkdown(noPreamble);
  return noMarkdown.trim();
}
