// Markdown-lite for chat answers (spec 010): paragraphs, "- " / "1. " lists,
// **bold**, _italic_ / *italic*, `code` and [text](https://link). Builds React
// nodes directly (never innerHTML), so model text can't inject markup.

import type { ReactNode } from 'react';

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|(?<![\p{L}\p{N}])_[^_\n]+_(?![\p{L}\p{N}])|(?<![\p{L}\p{N}*])\*[^*\n]+\*(?![\p{L}\p{N}*]))/gu;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const tok = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const k = `${key}-${i++}`;
    if (tok.startsWith('**')) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) {
      out.push(
        <code key={k} style={{ background: 'var(--color-surface-3)', borderRadius: 'var(--radius-xs)', padding: '1px 5px', fontSize: '0.92em' }}>
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith('[')) {
      const mm = tok.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      out.push(mm
        ? <a key={k} href={mm[2]} target="_blank" rel="noopener noreferrer nofollow" className="link-accent">{mm[1]}</a>
        : tok);
    } else out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    last = at + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MarkdownLite({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (!para.length) return;
    const k = `p${blocks.length}`;
    blocks.push(
      <p key={k} style={{ margin: '0 0 8px' }}>
        {para.flatMap((l, i) => (i ? [<br key={`${k}-br${i}`} />, ...inline(l, `${k}-${i}`)] : inline(l, `${k}-${i}`)))}
      </p>,
    );
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const k = `l${blocks.length}`;
    const items = list.items.map((it, i) => <li key={`${k}-${i}`}>{inline(it, `${k}-${i}`)}</li>);
    const style = { margin: '0 0 8px', paddingLeft: 20 };
    blocks.push(list.ordered
      ? <ol key={k} style={{ ...style, listStyle: 'decimal' }}>{items}</ol>
      : <ul key={k} style={{ ...style, listStyle: 'disc' }}>{items}</ul>);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-•*]\s+(.*)$/);
    const num = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || num) {
      flushPara();
      const ordered = !!num && !bullet;
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push((bullet ?? num)![1]);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return <>{blocks}</>;
}
