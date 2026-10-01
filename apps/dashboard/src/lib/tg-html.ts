// Allowlist sanitizer for Telegram-flavoured HTML produced by the editor's
// renderer (rendered_preview). The renderer already escapes model text; this is
// defence in depth before dangerouslySetInnerHTML: only Telegram's inline tags
// survive, links must be http(s), every attribute except href is dropped.

const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'INS', 'S', 'STRIKE', 'DEL', 'A', 'CODE', 'PRE', 'BLOCKQUOTE', 'TG-SPOILER', 'BR', 'SPAN']);

function clean(node: Node, doc: Document): Node[] {
  if (node.nodeType === Node.TEXT_NODE) return [doc.createTextNode(node.textContent ?? '')];
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const el = node as Element;
  const kids = Array.from(el.childNodes).flatMap((c) => clean(c, doc));
  if (!ALLOWED.has(el.tagName)) return kids; // unwrap unknown tags, keep their text
  const out = doc.createElement(el.tagName === 'TG-SPOILER' ? 'span' : el.tagName.toLowerCase());
  if (el.tagName === 'TG-SPOILER') {
    out.setAttribute('style', 'background: var(--color-surface-3); color: var(--color-ink-muted); border-radius: 3px;');
    out.setAttribute('title', 'spoiler');
  }
  if (el.tagName === 'A') {
    const href = el.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) {
      out.setAttribute('href', href);
      out.setAttribute('target', '_blank');
      out.setAttribute('rel', 'noopener noreferrer nofollow');
      out.setAttribute('class', 'link-accent');
    }
  }
  for (const k of kids) out.appendChild(k);
  return [out];
}

export function sanitizeTelegramHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const wrap = doc.createElement('div');
  for (const n of Array.from(doc.body.childNodes).flatMap((c) => clean(c, doc))) wrap.appendChild(n);
  return wrap.innerHTML;
}
