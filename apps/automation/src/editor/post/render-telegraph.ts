import type { TelegraphNode } from '../../publishers/telegraph.service';
import type { Block, InnerBlock, Longread } from './post-spec';
import { inlineToHtml, inlineToPlain } from './inline-markup';
import { tableRow } from './blocks';

type Element = Exclude<TelegraphNode, string>;

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/**
 * Markdown-lite inline text → Telegraph nodes. Reuses inlineToHtml (the one
 * grammar for **bold**, _italic_, [label](url), ||spoiler||) and walks its
 * output, which only ever contains escaped text plus b / i / a / tg-spoiler.
 * Telegraph has no spoiler, so its text is kept plain.
 */
export function inlineToTelegraph(src: string): TelegraphNode[] {
  const root: Element = { tag: 'root', children: [] };
  const stack: Element[] = [root];
  const top = () => stack[stack.length - 1];
  const re = /<(\/?)(b|i|a|tg-spoiler)(?: href="([^"]*)")?>/g;
  let last = 0;
  const html = inlineToHtml(src);
  const pushText = (t: string) => { if (t) top().children!.push(decode(t)); };
  for (let m = re.exec(html); m; m = re.exec(html)) {
    pushText(html.slice(last, m.index));
    last = re.lastIndex;
    const [, closing, tag, href] = m;
    if (tag === 'tg-spoiler') continue;
    if (closing) {
      if (stack.length > 1 && top().tag === tag) stack.pop();
      continue;
    }
    const el: Element = tag === 'a' ? { tag: 'a', attrs: { href: decode(href ?? '') }, children: [] } : { tag, children: [] };
    top().children!.push(el);
    stack.push(el);
  }
  pushText(html.slice(last));
  return root.children!;
}

/**
 * Telegraph has no tables, formulas or collapsible blocks (spec 033 FR-004):
 * headings → h3/h4, olist → ol, table → "a — b — c" rows, math → code,
 * divider → hr, details → h4 title + its blocks, footer → aside, code → pre.
 */
function blockToNodes(b: Block | InnerBlock): TelegraphNode[] {
  switch (b.type) {
    case 'lead':    return [{ tag: 'h3', children: inlineToTelegraph(b.text) }];
    case 'p':       return [{ tag: 'p', children: inlineToTelegraph(b.text) }];
    case 'quote':   return [{ tag: 'blockquote', children: inlineToTelegraph(b.text) }];
    case 'list':    return [{ tag: 'ul', children: b.items.map((i) => ({ tag: 'li', children: inlineToTelegraph(i) })) }];
    case 'heading': return [{ tag: b.level >= 3 ? 'h4' : 'h3', children: inlineToTelegraph(b.text) }];
    case 'olist':   return [{ tag: 'ol', children: b.items.map((i) => ({ tag: 'li', children: inlineToTelegraph(i) })) }];
    case 'table': {
      const w = b.header.length;
      const row = (r: string[]) => tableRow(r, w).map((c) => inlineToPlain(c).trim() || '—').join(' — ');
      return [
        { tag: 'p', children: [{ tag: 'strong', children: [row(b.header)] }] },
        ...b.rows.map((r): TelegraphNode => ({ tag: 'p', children: [row(r)] })),
      ];
    }
    case 'math':    return [{ tag: 'p', children: [{ tag: 'code', children: [b.expression] }] }];
    case 'divider': return [{ tag: 'hr' }];
    case 'footer':  return [{ tag: 'aside', children: inlineToTelegraph(b.text) }];
    case 'code':    return [{ tag: 'pre', children: [b.text] }];
    case 'details': return [{ tag: 'h4', children: inlineToTelegraph(b.title) }, ...b.body.flatMap(blockToNodes)];
  }
}

/** Pure: longread (+ optional cover image and source link) → Telegraph page content. */
export function longreadToTelegraph(lr: Longread, opts: { coverUrl?: string; source?: { url: string; label?: string } } = {}): TelegraphNode[] {
  const nodes: TelegraphNode[] = [];
  if (opts.coverUrl) nodes.push({ tag: 'figure', children: [{ tag: 'img', attrs: { src: opts.coverUrl } }] });
  nodes.push(...lr.blocks.flatMap(blockToNodes));
  if (opts.source) {
    nodes.push({ tag: 'p', children: ['Джерело: ', { tag: 'a', attrs: { href: opts.source.url }, children: [opts.source.label ?? opts.source.url] }] });
  }
  return nodes;
}
