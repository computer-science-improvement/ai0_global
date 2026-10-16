/** @jsxRuntime automatic */
/** @jsxImportSource react */
// Markdown-lite for chat answers (spec 010): paragraphs, "- " / "1. " lists,
// # headings, ``` code blocks, > quotes, --- dividers, | tables |, **bold**,
// _italic_ / *italic*, ~~strike~~, `code`, [text](https://link) and backslash
// escapes (\| \* \_ …). Builds React nodes directly (never innerHTML), so model
// text can't inject markup. The agents' chat prompts list the same subset
// (automation editor/chat/chat-format.ts) — change both together.

import type { ReactNode } from 'react';

const INLINE = /(\\[\\`*_{}[\]()#+\-.!|>~]|\*\*[^*\n]+\*\*|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|(?<![\p{L}\p{N}])_[^_\n]+_(?![\p{L}\p{N}])|(?<![\p{L}\p{N}*])\*[^*\n]+\*(?![\p{L}\p{N}*]))/gu;

const CODE_STYLE = { background: 'var(--color-surface-3)', borderRadius: 'var(--radius-xs)', padding: '1px 5px', fontSize: '0.92em' };

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const tok = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const k = `${key}-${i++}`;
    if (tok.startsWith('\\')) out.push(tok[1]);
    else if (tok.startsWith('**')) out.push(<strong key={k}>{inline(tok.slice(2, -2), k)}</strong>);
    else if (tok.startsWith('~~')) out.push(<del key={k}>{inline(tok.slice(2, -2), k)}</del>);
    else if (tok.startsWith('`')) out.push(<code key={k} style={CODE_STYLE}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('[')) {
      const mm = tok.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      out.push(mm
        ? <a key={k} href={mm[2]} target="_blank" rel="noopener noreferrer nofollow" className="link-accent">{mm[1]}</a>
        : tok);
    } else out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>);
    last = at + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Align = 'left' | 'center' | 'right' | undefined;

/** A table row's cells: split on pipes that are not escaped; the outer pipes are optional. */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) { cur += s[i] + s[i + 1]; i++; continue; }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

const SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const isSeparator = (line: string | undefined) => !!line && line.includes('-') && SEPARATOR.test(line);
const hasPipe = (line: string) => /(^|[^\\])\|/.test(line);

function alignOf(cell: string): Align {
  const c = cell.trim();
  const l = c.startsWith(':');
  const r = c.endsWith(':');
  return l && r ? 'center' : r ? 'right' : l ? 'left' : undefined;
}

export function MarkdownLite({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];

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
  const flushQuote = () => {
    if (!quote.length) return;
    const k = `q${blocks.length}`;
    blocks.push(
      <blockquote key={k} className="md-quote">
        {quote.flatMap((l, i) => (i ? [<br key={`${k}-br${i}`} />, ...inline(l, `${k}-${i}`)] : inline(l, `${k}-${i}`)))}
      </blockquote>,
    );
    quote = [];
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trimEnd();

    const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)\s*$/);
    if (fence) {
      flushAll();
      const body: string[] = [];
      while (++n < lines.length && !lines[n].trim().startsWith(fence[1])) body.push(lines[n]);
      blocks.push(
        <pre key={`c${blocks.length}`} className="md-pre" data-language={fence[2] || undefined}><code>{body.join('\n')}</code></pre>,
      );
      continue;
    }

    if (hasPipe(line) && isSeparator(lines[n + 1])) {
      flushAll();
      const head = splitRow(line);
      const aligns = splitRow(lines[n + 1]).map(alignOf);
      const rows: string[][] = [];
      n += 2;
      while (n < lines.length && lines[n].trim() && hasPipe(lines[n])) rows.push(splitRow(lines[n++]));
      n--;
      const k = `t${blocks.length}`;
      const cols = head.length;
      blocks.push(
        <div key={k} className="md-table-wrap" tabIndex={0} role="region" aria-label="Table">
          <table className="md-table">
            <thead><tr>{head.map((c, i) => <th key={i} style={{ textAlign: aligns[i] }}>{inline(c, `${k}-h${i}`)}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {Array.from({ length: cols }, (_, ci) => (
                    <td key={ci} style={{ textAlign: aligns[ci] }}>{inline(r[ci] ?? '', `${k}-${ri}-${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length, 3);
      const k = `h${blocks.length}`;
      blocks.push(<div key={k} role="heading" aria-level={level + 2} className={`md-h md-h${level}`}>{inline(heading[2], k)}</div>);
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushAll();
      blocks.push(<hr key={`r${blocks.length}`} className="md-hr" />);
      continue;
    }

    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) {
      flushPara();
      flushList();
      quote.push(q[1]);
      continue;
    }
    flushQuote();

    const bullet = line.match(/^\s*[-•*+]\s+(.*)$/);
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
  flushAll();
  return <>{blocks}</>;
}
