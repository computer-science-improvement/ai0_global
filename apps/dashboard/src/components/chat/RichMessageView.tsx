/** @jsxRuntime automatic */
/** @jsxImportSource react */
// Spec 033 FR-006: the body of a Telegram rich message (Bot API 10.1
// sendRichMessage) as the channel will show it — headings, numbered and bulleted
// lists, tables that scroll inside the bubble, monospace formulas, dividers,
// collapsible details and the footer. Pure React (no icons, no fetches) so it
// renders on the server in tests (the pragmas above keep the automatic JSX
// runtime under tsx, which does not read the app tsconfig); media blocks come
// from the caller.

import type { ReactNode } from 'react';
import type { TgRichBlock, TgRichListItem, TgRichText } from '../../api/types';

const safeHref = (u: string) => /^https?:\/\//i.test(u);

/** RichText → inline nodes. */
export function RichTextView({ t }: { t: TgRichText | undefined }): ReactNode {
  if (t == null) return null;
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return <>{t.map((x, i) => <RichTextView key={i} t={x} />)}</>;
  switch (t.type) {
    case 'bold':   return <b><RichTextView t={t.text} /></b>;
    case 'italic': return <i><RichTextView t={t.text} /></i>;
    case 'code':   return <code><RichTextView t={t.text} /></code>;
    case 'spoiler':
      return <span className="tg-rich-spoiler" title="spoiler"><RichTextView t={t.text} /></span>;
    case 'url':
      return safeHref(t.url)
        ? <a href={t.url} target="_blank" rel="noopener noreferrer nofollow"><RichTextView t={t.text} /></a>
        : <RichTextView t={t.text} />;
    case 'mathematical_expression':
      return <code className="tg-rich-math-inline">{t.expression}</code>;
  }
}

/** A list is numbered when its items carry the ordered label style ('1'). */
export function isNumberedList(items: TgRichListItem[]): boolean {
  return items.some((i) => i.type === '1');
}

export function RichBlocksView({ blocks, media }: {
  blocks: TgRichBlock[];
  /** Renders a photo / video block (the preview's media component). */
  media?: (src: string, kind: 'photo' | 'video') => ReactNode;
}) {
  return <>{blocks.map((b, i) => <RichBlockView key={i} b={b} media={media} />)}</>;
}

function RichBlockView({ b, media }: { b: TgRichBlock; media?: (src: string, kind: 'photo' | 'video') => ReactNode }): ReactNode {
  switch (b.type) {
    case 'paragraph':
      return <p className="tg-rich-p"><RichTextView t={b.text} /></p>;
    case 'heading': {
      const level = Math.min(Math.max(b.size, 1), 3);
      return <div className={`tg-rich-h tg-rich-h${level}`} role="heading" aria-level={level + 1}><RichTextView t={b.text} /></div>;
    }
    case 'pre':
      return <pre className="tg-rich-pre" data-language={b.language}><code><RichTextView t={b.text} /></code></pre>;
    case 'footer':
      return <div className="tg-rich-footer"><RichTextView t={b.text} /></div>;
    case 'divider':
      return <hr className="tg-rich-hr" />;
    case 'mathematical_expression':
      return <div className="tg-rich-math" title="Formula (LaTeX)">{b.expression}</div>;
    case 'list': {
      const items = b.items.map((it, i) => (
        <li key={i} value={it.value}><RichBlocksView blocks={it.blocks} media={media} /></li>
      ));
      return isNumberedList(b.items) ? <ol className="tg-rich-list">{items}</ol> : <ul className="tg-rich-list">{items}</ul>;
    }
    case 'blockquote':
      return <blockquote className="tg-rich-quote"><RichBlocksView blocks={b.blocks} media={media} /></blockquote>;
    case 'table': {
      const [head, ...rows] = b.cells;
      const headIsHeader = !!head?.length && head.every((c) => c.is_header);
      const body = headIsHeader ? rows : b.cells;
      return (
        <div className="tg-rich-table-wrap" role="region" aria-label="Table" tabIndex={0}>
          <table className="tg-rich-table" data-bordered={b.is_bordered ? 'true' : undefined}>
            {headIsHeader && (
              <thead><tr>{head.map((c, i) => <th key={i} style={{ textAlign: c.align }}><RichTextView t={c.text} /></th>)}</tr></thead>
            )}
            <tbody>
              {body.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (c.is_header
                    ? <th key={j} style={{ textAlign: c.align }}><RichTextView t={c.text} /></th>
                    : <td key={j} style={{ textAlign: c.align }}><RichTextView t={c.text} /></td>))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'details':
      return (
        <details className="tg-rich-details" open={b.is_open}>
          <summary><RichTextView t={b.summary} /></summary>
          <div className="tg-rich-details-body"><RichBlocksView blocks={b.blocks} media={media} /></div>
        </details>
      );
    case 'photo':
      return media ? <div className="tg-rich-media">{media(b.photo.media, 'photo')}</div> : null;
    case 'video':
      return media ? <div className="tg-rich-media">{media(b.video.media, 'video')}</div> : null;
  }
}
