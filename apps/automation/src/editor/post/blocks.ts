import type { Block, InnerBlock } from './post-spec';

/**
 * Spec 033: helpers shared by every consumer of PostSpec blocks (renderers,
 * lint, duplicate, the verbatim guard). The rich-only blocks map to plain
 * text here (FR-004) so no consumer has to know every block type.
 */

/** Blocks only Telegram Rich Messages show natively; everything else degrades to plain text / HTML. */
export const RICH_BLOCK_TYPES = ['heading', 'olist', 'table', 'math', 'divider', 'details', 'footer', 'code'] as const;
export type RichBlockType = typeof RICH_BLOCK_TYPES[number];
const RICH = new Set<string>(RICH_BLOCK_TYPES);

export function isRichBlock(b: Pick<Block, 'type'>): boolean {
  return RICH.has(b.type);
}

/** Does any block (nested details bodies included) need a rich message to show natively? */
export function usesRichBlocks(blocks: readonly Block[]): boolean {
  return blocks.some(isRichBlock);
}

/** Every block, nested `details` bodies included (the FR-001 ≤ 60 limit). */
export function countBlocks(blocks: readonly Block[]): number {
  return blocks.reduce((n, b) => n + 1 + (b.type === 'details' ? b.body.length : 0), 0);
}

/** A table row padded / cut to the header width. */
export function tableRow(row: readonly string[], width: number): string[] {
  return Array.from({ length: width }, (_, i) => row[i] ?? '');
}

/**
 * One block as plain text lines (FR-004): headings → a line, olist → "1." lines,
 * table → "a — b — c" rows (header first), math → the expression, divider → an
 * empty string (a blank line between neighbours), details → title + body.
 * `inline` turns the markdown-lite of a text into what the target shows.
 */
export function blockPlain(b: Block | InnerBlock, inline: (s: string) => string): string {
  switch (b.type) {
    case 'lead':
    case 'p':
    case 'heading':
    case 'footer':  return inline(b.text);
    case 'quote':   return `«${inline(b.text)}»`;
    case 'list':    return b.items.map((i) => `• ${inline(i)}`).join('\n');
    case 'olist':   return b.items.map((i, n) => `${n + 1}. ${inline(i)}`).join('\n');
    case 'table': {
      const w = b.header.length;
      return [b.header, ...b.rows].map((r) => tableRow(r, w).map((c) => inline(c).trim() || '—').join(' — ')).join('\n');
    }
    case 'math':    return b.expression;
    case 'code':    return b.text;
    case 'divider': return '';
    case 'details': return [inline(b.title), ...b.body.map((x) => blockPlain(x, inline))].filter(Boolean).join('\n');
  }
}

/** The reader's text of a block for length, language and copy checks (no decoration, only words). */
export function blockWords(b: Block | InnerBlock, inline: (s: string) => string): string {
  switch (b.type) {
    case 'list':
    case 'olist':   return b.items.map(inline).join('\n');
    case 'quote':   return inline(b.text);
    case 'table':   return [b.header, ...b.rows].map((r) => r.map(inline).join(' ')).join('\n');
    case 'details': return [inline(b.title), ...b.body.map((x) => blockWords(x, inline))].join('\n');
    default:        return blockPlain(b, inline);
  }
}
