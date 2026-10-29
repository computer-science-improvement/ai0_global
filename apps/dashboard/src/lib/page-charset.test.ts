// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 076 FR-009 (A13): a saved page is decoded in the charset it declares, so a windows-1251 page does not reach the
// server as U+FFFD. Cyrillic is written as \u escapes (the no-cyrillic-ui test keeps letters out of dashboard source).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentTypeOf, decodePageBytes } from './page-charset';

// WORD is a Ukrainian sample ("Hello, Hedgehog"); the letters the 1251 table puts outside the plain A-ya range are in it.
const WORD = '\u041F\u0440\u0438\u0432\u0456\u0442, \u0407\u0436\u0430\u043A \u0454 \u0451';

/** U+0410..U+044F map to 0xC0..0xFF; the rest of the Ukrainian and Russian extras are single codes. */
const CP1251_EXTRA: Record<number, number> = {
  0x0401: 0xa8, 0x0451: 0xb8, 0x0406: 0xb2, 0x0456: 0xb3, 0x0407: 0xaf, 0x0457: 0xbf, 0x0404: 0xaa, 0x0454: 0xba,
};
function cp1251(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c >= 0x0410 && c <= 0x044f) out.push(0xc0 + (c - 0x0410));
    else if (CP1251_EXTRA[c] !== undefined) out.push(CP1251_EXTRA[c]);
    else throw new Error(`no cp1251 byte for U+${c.toString(16)}`);
  }
  return Uint8Array.from(out);
}
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

test('a page with no declaration is UTF-8', () => {
  const r = decodePageBytes(utf8(`<html><body><p>${WORD}</p></body></html>`));
  assert.equal(r.charset, 'utf-8');
  assert.ok(r.text.includes(WORD));
});

test('a windows-1251 page that says so in <meta charset> is read as windows-1251', () => {
  const bytes = concat(utf8('<html><head><meta charset="windows-1251"></head><body>'), cp1251(WORD), utf8('</body></html>'));
  const r = decodePageBytes(bytes);
  assert.equal(r.charset, 'windows-1251');
  assert.ok(r.text.includes(WORD), 'the letters survive');
  assert.ok(!r.text.includes('\uFFFD'));
});

test('the old <meta http-equiv="Content-Type" content="text/html; charset=…"> form is read too', () => {
  const bytes = concat(utf8('<HTML><HEAD><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=WINDOWS-1251"></HEAD><BODY>'), cp1251(WORD));
  const r = decodePageBytes(bytes);
  assert.equal(r.charset, 'windows-1251');
  assert.ok(r.text.includes(WORD));
});

test('an <?xml encoding="…"?> declaration is read', () => {
  const bytes = concat(utf8('<?xml version="1.0" encoding="windows-1251"?><feed><title>'), cp1251(WORD), utf8('</title></feed>'));
  const r = decodePageBytes(bytes);
  assert.equal(r.charset, 'windows-1251');
  assert.ok(r.text.includes(WORD));
});

test('a UTF-8 byte-order mark is removed from the text', () => {
  const r = decodePageBytes(concat(Uint8Array.of(0xef, 0xbb, 0xbf), utf8(`<p>${WORD}</p>`)));
  assert.equal(r.charset, 'utf-8');
  assert.equal(r.text, `<p>${WORD}</p>`);
  assert.ok(!r.text.startsWith('\uFEFF'));
});

test('UTF-16 little and big endian marks are read and removed', () => {
  const text = `<p>${WORD}</p>`;
  const le = new Uint8Array(2 + text.length * 2);
  le.set([0xff, 0xfe]);
  const be = new Uint8Array(2 + text.length * 2);
  be.set([0xfe, 0xff]);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    le[2 + i * 2] = c & 0xff; le[3 + i * 2] = c >> 8;
    be[2 + i * 2] = c >> 8;   be[3 + i * 2] = c & 0xff;
  }
  assert.deepEqual(decodePageBytes(le), { text, charset: 'utf-16le' });
  assert.deepEqual(decodePageBytes(be), { text, charset: 'utf-16be' });
});

test('a byte-order mark wins over a <meta> that says otherwise', () => {
  const r = decodePageBytes(concat(Uint8Array.of(0xef, 0xbb, 0xbf), utf8(`<meta charset="windows-1251"><p>${WORD}</p>`)));
  assert.equal(r.charset, 'utf-8');
  assert.ok(r.text.includes(WORD));
});

test('an unknown label falls back to UTF-8 instead of throwing', () => {
  const r = decodePageBytes(utf8(`<meta charset="no-such-charset-9"><p>${WORD}</p>`));
  assert.equal(r.charset, 'utf-8');
  assert.ok(r.text.includes(WORD));
});

test('a <meta> past the first 4 KB is ignored', () => {
  const pad = '<!-- ' + 'x'.repeat(4200) + ' -->';
  const r = decodePageBytes(concat(utf8(pad), utf8('<meta charset="windows-1251">'), utf8(`<p>${WORD}</p>`)));
  assert.equal(r.charset, 'utf-8');
  assert.ok(r.text.includes(WORD), 'read as UTF-8, so the UTF-8 bytes stay letters');
});

test('koi8-u pages are read when they declare it', () => {
  // 0xE6 is U+0424 in koi8-u; a lone byte is enough to tell the table from windows-1251 (where 0xE6 is U+0436).
  const r = decodePageBytes(concat(utf8('<meta charset="koi8-u">'), Uint8Array.of(0xe6)));
  assert.equal(r.charset, 'koi8-u');
  assert.ok(r.text.endsWith('\u0424'));
});

test('an empty file is an empty text', () => {
  assert.deepEqual(decodePageBytes(new Uint8Array()), { text: '', charset: 'utf-8' });
});

test('contentTypeOf: a file is told by its extension, in any case', () => {
  assert.equal(contentTypeOf('page.html', ''), 'text/html');
  assert.equal(contentTypeOf('Page.HTM', 'plain words'), 'text/html');
  assert.equal(contentTypeOf('notes.txt', '<p>tags</p>'), 'text/plain', 'the extension wins over what the text looks like');
  assert.equal(contentTypeOf('README.md', ''), 'text/markdown');
  assert.equal(contentTypeOf('a.markdown', ''), 'text/markdown');
});

test('contentTypeOf: pasted text is told by what it looks like', () => {
  assert.equal(contentTypeOf(null, '<!DOCTYPE html><html><body>x</body></html>'), 'text/html');
  assert.equal(contentTypeOf(null, 'Intro\n<div class="a">x</div>'), 'text/html');
  assert.equal(contentTypeOf(null, '# Title\n\nSome text'), 'text/markdown');
  assert.equal(contentTypeOf(null, '- one\n- two'), 'text/markdown');
  assert.equal(contentTypeOf(null, 'Just a few plain lines.\nNothing else.'), 'text/plain');
  assert.equal(contentTypeOf(null, 'a < b and b > c'), 'text/plain', 'a bare angle bracket is not a tag');
});
