import type { Block, InnerBlock } from './post-spec';
import { inlineToHtml } from './inline-markup';
import { tableRow } from './blocks';

/**
 * Spec 033 FR-002: PostSpec blocks → Bot API 10.1 Rich Messages
 * (`sendRichMessage` / `editMessageText.rich_message` with
 * `InputRichMessage.blocks`). The types below are the subset of the Bot API
 * objects this renderer emits, with the exact field names and `type` values of
 * https://core.telegram.org/bots/api (InputRichBlock*, RichText*,
 * RichBlockTableCell, InputRichBlockListItem). Pure; no I/O.
 */

/** RichText: a plain string, an array of RichText, or a typed formatting object. */
export type RichText =
  | string
  | RichText[]
  | { type: 'bold' | 'italic' | 'spoiler' | 'code'; text: RichText }
  | { type: 'url'; text: RichText; url: string }
  | { type: 'mathematical_expression'; expression: string };

/** InputRichBlockListItem. `type: '1'` + `value` mark a numbered item (the API describes both "for ordered lists"). */
export interface RichListItem { blocks: RichBlock[]; type?: '1'; value?: number }

/** RichBlockTableCell. */
export interface RichTableCell { text?: RichText; is_header?: true; align?: 'left' | 'center' | 'right' }

/** InputRichBlock* (the subset we emit). */
export type RichBlock =
  | { type: 'paragraph'; text: RichText }
  | { type: 'heading'; text: RichText; size: number }
  | { type: 'pre'; text: RichText; language?: string }
  | { type: 'footer'; text: RichText }
  | { type: 'divider' }
  | { type: 'mathematical_expression'; expression: string }
  | { type: 'list'; items: RichListItem[] }
  | { type: 'blockquote'; blocks: RichBlock[] }
  | { type: 'table'; cells: RichTableCell[][]; is_bordered?: true; is_striped?: true }
  | { type: 'details'; summary: RichText; blocks: RichBlock[]; is_open?: true }
  | { type: 'photo'; photo: { type: 'photo'; media: string } }
  | { type: 'video'; video: { type: 'video'; media: string; supports_streaming?: true } };

/** Bot API limits of one rich message (InputRichMessage). */
export const RICH_MAX_CHARS = 32_768;
export const RICH_MAX_BLOCKS = 500;
export const RICH_MAX_DEPTH = 16;

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** Collapse a node list: [] → '', ['x'] → 'x', a single object stays an object. */
function collapse(nodes: RichText[]): RichText {
  if (!nodes.length) return '';
  return nodes.length === 1 ? nodes[0] : nodes;
}

/**
 * Markdown-lite (**bold**, _italic_, [label](url), ||spoiler||) → RichText.
 * Reuses inlineToHtml — the one grammar — and walks its output, which only
 * ever contains escaped text plus b / i / a / tg-spoiler.
 */
export function inlineToRich(src: string): RichText {
  type Frame = { kind: 'root' | 'b' | 'i' | 'a' | 'tg-spoiler'; url?: string; children: RichText[] };
  const stack: Frame[] = [{ kind: 'root', children: [] }];
  const top = () => stack[stack.length - 1];
  const re = /<(\/?)(b|i|a|tg-spoiler)(?: href="([^"]*)")?>/g;
  const html = inlineToHtml(src);
  let last = 0;
  const pushText = (t: string) => { if (t) top().children.push(decode(t)); };
  const close = () => {
    const f = stack.pop()!;
    const text = collapse(f.children);
    const node: RichText = f.kind === 'a' ? { type: 'url', text, url: f.url ?? '' }
      : { type: f.kind === 'b' ? 'bold' : f.kind === 'i' ? 'italic' : 'spoiler', text };
    top().children.push(node);
  };
  for (let m = re.exec(html); m; m = re.exec(html)) {
    pushText(html.slice(last, m.index));
    last = re.lastIndex;
    const [, closing, tag, href] = m;
    if (closing) {
      if (stack.length > 1 && top().kind === tag) close();
      continue;
    }
    stack.push({ kind: tag as Frame['kind'], ...(tag === 'a' ? { url: decode(href ?? '') } : {}), children: [] });
  }
  pushText(html.slice(last));
  while (stack.length > 1) close();
  return collapse(stack[0].children);
}

const para = (src: string): RichBlock => ({ type: 'paragraph', text: inlineToRich(src) });

/** One PostSpec block → rich blocks (a lead is a bold paragraph, like the HTML render). */
export function blockToRich(b: Block | InnerBlock): RichBlock[] {
  switch (b.type) {
    case 'lead':    return [{ type: 'paragraph', text: { type: 'bold', text: inlineToRich(b.text) } }];
    case 'p':       return [para(b.text)];
    case 'quote':   return [{ type: 'blockquote', blocks: [para(b.text)] }];
    case 'list':    return [{ type: 'list', items: b.items.map((i) => ({ blocks: [para(i)] })) }];
    case 'olist':   return [{ type: 'list', items: b.items.map((i, n) => ({ blocks: [para(i)], type: '1' as const, value: n + 1 })) }];
    case 'heading': return [{ type: 'heading', text: inlineToRich(b.text), size: b.level }];
    case 'table': {
      const w = b.header.length;
      return [{
        type: 'table', is_bordered: true,
        cells: [
          tableRow(b.header, w).map((c): RichTableCell => ({ text: inlineToRich(c), is_header: true })),
          ...b.rows.map((r) => tableRow(r, w).map((c): RichTableCell => ({ text: inlineToRich(c) }))),
        ],
      }];
    }
    case 'math':    return [{ type: 'mathematical_expression', expression: b.expression }];
    case 'divider': return [{ type: 'divider' }];
    case 'footer':  return [{ type: 'footer', text: inlineToRich(b.text) }];
    case 'code':    return [{ type: 'pre', text: b.text, ...(b.language ? { language: b.language } : {}) }];
    case 'details': return [{ type: 'details', summary: inlineToRich(b.title), blocks: b.body.flatMap(blockToRich) }];
  }
}

function textLength(t: RichText | undefined): number {
  if (t == null) return 0;
  if (typeof t === 'string') return [...t].length;
  if (Array.isArray(t)) return t.reduce((n, x) => n + textLength(x), 0);
  if (t.type === 'mathematical_expression') return [...t.expression].length;
  return textLength(t.text);
}

/**
 * What the Bot API counts against an InputRichMessage: characters (formula
 * source included), blocks (nested blocks, list items and table rows
 * included) and nesting depth.
 */
export function richStats(blocks: RichBlock[], depth = 1): { chars: number; blocks: number; depth: number } {
  let chars = 0;
  let count = 0;
  let maxDepth = depth;
  const nested = (bs: RichBlock[]) => {
    const s = richStats(bs, depth + 1);
    chars += s.chars; count += s.blocks; maxDepth = Math.max(maxDepth, s.depth);
  };
  for (const b of blocks) {
    count += 1;
    switch (b.type) {
      case 'paragraph': case 'heading': case 'pre': case 'footer': chars += textLength(b.text); break;
      case 'mathematical_expression': chars += [...b.expression].length; break;
      case 'list': count += b.items.length; for (const i of b.items) nested(i.blocks); break;
      case 'blockquote': nested(b.blocks); break;
      case 'details': chars += textLength(b.summary); nested(b.blocks); break;
      case 'table': count += b.cells.length; for (const r of b.cells) for (const c of r) chars += textLength(c.text); break;
      default: break;
    }
  }
  return { chars, blocks: count, depth: maxDepth };
}

/** Plain text of rich blocks (owner alerts, similarity checks, logs). */
export function richToPlain(blocks: RichBlock[]): string {
  const t = (x: RichText | undefined): string => {
    if (x == null) return '';
    if (typeof x === 'string') return x;
    if (Array.isArray(x)) return x.map(t).join('');
    if (x.type === 'mathematical_expression') return x.expression;
    return t(x.text);
  };
  return blocks.map((b): string => {
    switch (b.type) {
      case 'paragraph': case 'heading': case 'pre': case 'footer': return t(b.text);
      case 'mathematical_expression': return b.expression;
      case 'divider': return '';
      case 'list': return b.items.map((i, n) => `${i.type === '1' ? `${i.value ?? n + 1}.` : '•'} ${richToPlain(i.blocks)}`).join('\n');
      case 'blockquote': return richToPlain(b.blocks);
      case 'details': return [t(b.summary), richToPlain(b.blocks)].join('\n');
      case 'table': return b.cells.map((r) => r.map((c) => t(c.text)).join(' — ')).join('\n');
      case 'photo': return '';
      case 'video': return '';
    }
  }).filter(Boolean).join('\n\n');
}
