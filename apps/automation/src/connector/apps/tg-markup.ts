/**
 * Spec 104: Telegram-HTML → a small allowlisted tree for the MCP Apps view.
 *
 * Captions come from posts, sources and agents, so they are untrusted. The view never parses or injects HTML: the server
 * turns the caption into these nodes, and the widget builds DOM from them with createElement and textContent only.
 * Only Telegram's own formatting survives (bold, italic, underline, strike, spoiler, code, pre with a language,
 * blockquote, links); links keep an http(s) href and nothing else; every other tag is dropped and its text kept.
 */

export type TgNode =
  | { t: 'text'; v: string }
  | { t: 'b' | 'i' | 'u' | 's' | 'code' | 'spoiler' | 'quote'; c: TgNode[] }
  | { t: 'pre'; lang: string | null; c: TgNode[] }
  | { t: 'a'; href: string | null; c: TgNode[] };

type Wrap = Exclude<TgNode, { t: 'text' }>;
type WrapKind = Wrap['t'];

/** Bounds of one caption: a longer or deeper one is cut, never rejected. */
export const MARKUP_MAX_NODES = 2000;
export const MARKUP_MAX_DEPTH = 10;
export const MARKUP_MAX_TEXT = 12_000;
const HREF_MAX = 2000;
const LANG_RE = /^[a-z0-9][a-z0-9+#._-]{0,30}$/i;

const TAGS: Record<string, WrapKind> = {
  b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', ins: 'u', s: 's', strike: 's', del: 's',
  code: 'code', pre: 'pre', blockquote: 'quote', 'tg-spoiler': 'spoiler', a: 'a',
};

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0' };

/** Telegram's entities (&amp; &lt; &gt; &quot;, numeric) plus the usual few; anything else stays as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      // Lone surrogates and code points past Unicode are not characters.
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : all;
    }
    return NAMED[e.toLowerCase()] ?? all;
  });
}

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function attrsOf(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return out;
}

/** An http(s) link the view may open (through the host), or null. No other scheme, no control characters. */
export function safeHref(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s || s.length > HREF_MAX || /\s/.test(s) || [...s].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*)?)\/?>/g;

/** Parse a Telegram-HTML caption into allowlisted nodes. Never throws; unbalanced or unknown tags degrade to text. */
export function parseTelegramHtml(html: string | null | undefined): TgNode[] {
  const src = typeof html === 'string' ? html : '';
  const root: { c: TgNode[] } = { c: [] };
  const stack: Array<{ tag: string; node: { c: TgNode[] } | null }> = [];
  let nodes = 0;
  let textLeft = MARKUP_MAX_TEXT;
  const top = (): { c: TgNode[] } => {
    for (let i = stack.length - 1; i >= 0; i--) { const n = stack[i].node; if (n) return n; }
    return root;
  };
  const depth = () => stack.filter((s) => s.node).length;
  const addText = (v: string) => {
    if (!v || textLeft <= 0 || nodes >= MARKUP_MAX_NODES) return;
    const cut = v.length > textLeft ? `${v.slice(0, Math.max(0, textLeft - 1))}…` : v;
    textLeft -= cut.length;
    const into = top().c;
    const last = into[into.length - 1];
    if (last && last.t === 'text') { last.v += cut; return; }
    into.push({ t: 'text', v: cut });
    nodes++;
  };

  let at = 0;
  for (const m of src.matchAll(TAG_RE)) {
    addText(decodeEntities(src.slice(at, m.index)));
    at = (m.index ?? 0) + m[0].length;
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    if (name === 'br') { if (!closing) addText('\n'); continue; }
    if (closing) {
      const i = stack.map((s) => s.tag).lastIndexOf(name);
      if (i >= 0) stack.length = i; // closes it and anything left open inside it
      continue;
    }
    const attrs = attrsOf(m[3] ?? '');
    let kind: WrapKind | undefined = TAGS[name];
    if (name === 'span' && /(^|\s)tg-spoiler(\s|$)/.test(attrs.class ?? '')) kind = 'spoiler';
    const parent = top();
    const parentNode = parent === root ? null : parent as Wrap;
    // <pre><code class="language-x"> is one code block: the language moves to the pre, the code tag goes.
    if (kind === 'code' && parentNode?.t === 'pre') {
      const lang = /^language-(.+)$/.exec(attrs.class ?? '')?.[1];
      if (lang && LANG_RE.test(lang) && !parentNode.lang) parentNode.lang = lang;
      stack.push({ tag: name, node: null });
      continue;
    }
    if (!kind || depth() >= MARKUP_MAX_DEPTH || nodes >= MARKUP_MAX_NODES) { stack.push({ tag: name, node: null }); continue; }
    const node: Wrap = kind === 'a' ? { t: 'a', href: safeHref(attrs.href), c: [] }
      : kind === 'pre' ? { t: 'pre', lang: null, c: [] }
      : { t: kind, c: [] };
    parent.c.push(node);
    nodes++;
    stack.push({ tag: name, node });
  }
  addText(decodeEntities(src.slice(at)));
  return root.c;
}

/** The visible text of nodes (tests, summaries). */
export function plainText(nodes: TgNode[]): string {
  return nodes.map((n) => (n.t === 'text' ? n.v : plainText(n.c))).join('');
}
