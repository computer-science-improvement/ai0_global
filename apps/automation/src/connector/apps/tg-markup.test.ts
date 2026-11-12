import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKUP_MAX_DEPTH, MARKUP_MAX_NODES, MARKUP_MAX_TEXT, decodeEntities, parseTelegramHtml, plainText, safeHref, type TgNode } from './tg-markup';

/** Every node of a tree, depth first. */
function walk(nodes: TgNode[], out: TgNode[] = []): TgNode[] {
  for (const n of nodes) { out.push(n); if (n.t !== 'text') walk(n.c, out); }
  return out;
}
const kinds = (html: string) => walk(parseTelegramHtml(html)).map((n) => n.t);
const ALLOWED = new Set(['text', 'b', 'i', 'u', 's', 'code', 'spoiler', 'quote', 'pre', 'a']);

test('spec 104: the prompts-channel post parses into Telegram formatting only', () => {
  const html = '💬 <b>Prompt:</b>\n<pre><code class="language-text">a cozy &lt;loft&gt; interior, warm light</code></pre>\n🤖 <i>Midjourney 6</i>\n📐 960x1200\n<a href="https://prompthero.com/prompt/abc">→ автор</a>\n#interior_design';
  const nodes = parseTelegramHtml(html);
  assert.deepEqual(nodes[1], { t: 'b', c: [{ t: 'text', v: 'Prompt:' }] });
  const pre = nodes.find((n) => n.t === 'pre');
  assert.deepEqual(pre, { t: 'pre', lang: 'text', c: [{ t: 'text', v: 'a cozy <loft> interior, warm light' }] }, 'the code tag goes, its language moves to the pre');
  assert.deepEqual(nodes.find((n) => n.t === 'i'), { t: 'i', c: [{ t: 'text', v: 'Midjourney 6' }] });
  assert.deepEqual(nodes.find((n) => n.t === 'a'), { t: 'a', href: 'https://prompthero.com/prompt/abc', c: [{ t: 'text', v: '→ автор' }] });
  assert.match(plainText(nodes), /#interior_design$/);
});

test('every Telegram tag and alias; br is a newline; tg-spoiler and span.tg-spoiler', () => {
  assert.deepEqual(kinds('<strong>a</strong><em>b</em><ins>c</ins><strike>d</strike><del>e</del><blockquote>f</blockquote><tg-spoiler>g</tg-spoiler><span class="tg-spoiler">h</span>'),
    ['b', 'text', 'i', 'text', 'u', 'text', 's', 'text', 's', 'text', 'quote', 'text', 'spoiler', 'text', 'spoiler', 'text']);
  assert.equal(plainText(parseTelegramHtml('a<br>b<br/>c')), 'a\nb\nc');
  assert.deepEqual(parseTelegramHtml('<code>x</code>'), [{ t: 'code', c: [{ t: 'text', v: 'x' }] }], 'inline code outside pre stays code');
});

test('hostile markup: scripts, handlers, iframes, styles and SVG become plain text, never elements or attributes', () => {
  const evil = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<iframe src="https://evil.test"></iframe>', '<svg onload=alert(1)><a xlink:href="javascript:alert(1)">x</a></svg>',
    '<b onclick="steal()">bold</b>', '<a href="https://ok.test" onmouseover="x()" style="color:red">ok</a>', '<style>*{display:none}</style>', '<object data="x"></object>',
    '<form action="https://evil.test"><input name=a></form>', '<meta http-equiv="refresh" content="0;url=https://evil.test">', '<base href="https://evil.test/">',
  ].join('');
  const all = walk(parseTelegramHtml(evil));
  for (const n of all) {
    assert.ok(ALLOWED.has(n.t), `unexpected node ${n.t}`);
    assert.deepEqual(Object.keys(n).sort(), n.t === 'text' ? ['t', 'v'] : n.t === 'a' ? ['c', 'href', 't'] : n.t === 'pre' ? ['c', 'lang', 't'] : ['c', 't'], 'no attribute survives');
  }
  assert.equal(all.find((n) => n.t === 'b')!.t, 'b', 'the bold text keeps its formatting, not its handler');
  // The text of a script stays text (the view shows it as text): no tag of it is kept.
  assert.match(plainText(parseTelegramHtml('<script>alert(1)</script>')), /^alert\(1\)$/);
  assert.equal(plainText(parseTelegramHtml('&lt;script&gt;alert(1)&lt;/script&gt;')), '<script>alert(1)</script>', 'escaped markup is decoded to text, not parsed');
});

test('links: http(s) only; javascript:, data:, vbscript:, file: and obfuscated schemes lose their href', () => {
  const href = (h: string) => (parseTelegramHtml(`<a href="${h}">x</a>`)[0] as { href: string | null }).href;
  assert.equal(href('https://t.me/x'), 'https://t.me/x');
  assert.equal(href('http://example.com/a?b=1&amp;c=2'), 'http://example.com/a?b=1&c=2');
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java&#x09;script:alert(1)', 'java&#10;script:alert(1)', '&#106;avascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox(1)', 'file:///etc/passwd', 'tg://resolve?domain=x', '//evil.test/x', '/relative', 'https://a b.test', `https://x.test/${'a'.repeat(2100)}`]) {
    assert.equal(href(bad), null, bad);
  }
  assert.equal(safeHref('https://ok.test/\u0000x'), null, 'control characters');
  assert.equal(safeHref('https://ok.test/\u007fx'), null, 'DEL');
  assert.equal((parseTelegramHtml("<a href='https://single.test'>x</a>")[0] as any).href, 'https://single.test/');
  assert.equal((parseTelegramHtml('<a href=https://bare.test>x</a>')[0] as any).href, 'https://bare.test/');
  assert.equal((parseTelegramHtml('<a>x</a>')[0] as any).href, null, 'no href → plain text in a link node');
  assert.equal((parseTelegramHtml('<a href="https://first.test" href="javascript:x">x</a>')[0] as any).href, 'https://first.test/', 'the first attribute wins');
});

test('pre language: only a short safe token; anything else is dropped', () => {
  const lang = (cls: string) => (parseTelegramHtml(`<pre><code class="${cls}">x</code></pre>`)[0] as { lang: string | null }).lang;
  assert.equal(lang('language-python'), 'python');
  assert.equal(lang('language-c++'), 'c++');
  assert.equal(lang('language-"><script>'), null);
  assert.equal(lang('language-' + 'x'.repeat(40)), null);
  assert.equal(lang('other'), null);
});

test('entities: Telegram\'s and numeric; lone surrogates and out-of-range code points stay as written', () => {
  assert.equal(decodeEntities('&amp;&lt;&gt;&quot;&#39;&#x41;&nbsp;&unknown;'), '&<>"\'A &unknown;');
  assert.equal(decodeEntities('&#xD800;&#1114112;&#0;'), '&#xD800;&#1114112;&#0;');
  assert.equal(decodeEntities('&amp;lt;'), '&lt;', 'decoded once, not twice');
});

test('unbalanced and stray tags degrade to text; a closing tag closes what was left open inside it', () => {
  assert.equal(plainText(parseTelegramHtml('</b>a<b>b')), 'ab');
  assert.deepEqual(parseTelegramHtml('<b>x<i>y</b>z'), [{ t: 'b', c: [{ t: 'text', v: 'x' }, { t: 'i', c: [{ t: 'text', v: 'y' }] }] }, { t: 'text', v: 'z' }]);
  assert.equal(plainText(parseTelegramHtml('a < b > c & d')), 'a < b > c & d', 'a lone < is text');
  assert.deepEqual(parseTelegramHtml(null), []);
  assert.deepEqual(parseTelegramHtml(42 as unknown as string), []);
});

test('bounds: depth, node count and text length are capped, never rejected', () => {
  const deep = parseTelegramHtml(`${'<b>'.repeat(50)}x${'</b>'.repeat(50)}`);
  let depth = 0;
  let n: TgNode | undefined = deep[0];
  while (n && n.t !== 'text') { depth++; n = n.c[0]; }
  assert.equal(depth, MARKUP_MAX_DEPTH);
  assert.equal(plainText(deep), 'x');
  const many = walk(parseTelegramHtml('<b>x</b>'.repeat(5000)));
  assert.ok(many.length <= MARKUP_MAX_NODES, `${many.length} nodes`);
  const long = plainText(parseTelegramHtml('y'.repeat(50_000)));
  assert.equal(long.length, MARKUP_MAX_TEXT);
  assert.ok(long.endsWith('…'));
});
