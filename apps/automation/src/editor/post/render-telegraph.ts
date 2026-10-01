import type { TelegraphNode } from '../../publishers/telegraph.service';
import type { Block, Longread } from './post-spec';
import { inlineToHtml } from './inline-markup';

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

function blockToNode(b: Block): TelegraphNode {
  switch (b.type) {
    case 'lead':  return { tag: 'h3', children: inlineToTelegraph(b.text) };
    case 'p':     return { tag: 'p', children: inlineToTelegraph(b.text) };
    case 'quote': return { tag: 'blockquote', children: inlineToTelegraph(b.text) };
    case 'list':  return { tag: 'ul', children: b.items.map((i) => ({ tag: 'li', children: inlineToTelegraph(i) })) };
  }
}

/** Pure: longread (+ optional cover image and source link) → Telegraph page content. */
export function longreadToTelegraph(lr: Longread, opts: { coverUrl?: string; source?: { url: string; label?: string } } = {}): TelegraphNode[] {
  const nodes: TelegraphNode[] = [];
  if (opts.coverUrl) nodes.push({ tag: 'figure', children: [{ tag: 'img', attrs: { src: opts.coverUrl } }] });
  nodes.push(...lr.blocks.map(blockToNode));
  if (opts.source) {
    nodes.push({ tag: 'p', children: ['Джерело: ', { tag: 'a', attrs: { href: opts.source.url }, children: [opts.source.label ?? opts.source.url] }] });
  }
  return nodes;
}
