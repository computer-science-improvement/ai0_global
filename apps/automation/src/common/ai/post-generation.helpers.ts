/**
 * Converts stray Markdown emphasis to Telegram HTML so the visual
 * hierarchy survives even when the AI emits Markdown despite the system
 * prompt asking for HTML. Also strips horizontal rules and collapses
 * excessive newlines.
 */
export function convertStrayMarkdown(s: string): string {
  return s
    // Bold: **word** / __word__ → <b>word</b>
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    // Italic: *word* (with non-word boundaries) → <i>word</i>
    .replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, '<i>$1</i>')
    // Horizontal rules: drop the line entirely
    .replace(/^[ \t]*-{3,}[ \t]*$/gm, '')
    // Collapse 3+ newlines to 2
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
 * Combines preamble stripping + stray-markdown conversion. Order matters: preambles
 * first (so their bold/HTML wrappers are removed before we try to convert standalone
 * bold), then markdown conversion.
 */
export function cleanFinalText(raw: string): string {
  const noPreamble = stripPreambles(raw);
  const converted = convertStrayMarkdown(noPreamble);
  return converted.trim();
}
