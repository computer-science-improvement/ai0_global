// Spec 076 FR-009 (A13): a page saved from a browser is bytes, and a Ukrainian site may still be windows-1251 or koi8-u.
// `File.text()` always reads UTF-8, so a 1251 page would reach the server as U+FFFD in every Cyrillic letter. The upload
// dialog reads the file as bytes and decodes it here, in the charset the page itself declares: a byte-order mark first, then
// `<meta charset>` / `<meta http-equiv … charset=>` / `<?xml encoding>` in the first 4 KB (the same order as the server's
// `declaredCharset`, minus the Content-Type header a file does not have), then UTF-8. Pure: no DOM, so it is node-tested.

export type PageContentType = 'text/html' | 'text/plain' | 'text/markdown';

/** How far into the file a charset declaration is looked for (the HTML spec's own limit is 1024; 4 KB is the server's). */
const HEAD_BYTES = 4096;

function bomOf(bytes: Uint8Array): { label: string; skip: number } | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { label: 'utf-8', skip: 3 };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { label: 'utf-16le', skip: 2 };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { label: 'utf-16be', skip: 2 };
  return null;
}

/** The label a page declares in its first 4 KB, lower-cased; null when it declares none. */
function declaredLabel(bytes: Uint8Array): string | null {
  // latin1 maps every byte to one character, so ASCII markup is readable whatever the page's own charset is.
  let head = '';
  const n = Math.min(bytes.length, HEAD_BYTES);
  for (let i = 0; i < n; i++) head += String.fromCharCode(bytes[i]);
  const found = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] ?? /<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)/i.exec(head)?.[1];
  return found ? found.toLowerCase() : null;
}

/**
 * A page's bytes as text, and the charset that was used. An unknown label (TextDecoder throws a RangeError) falls back to
 * UTF-8. A byte-order mark is removed from the text and wins over a `<meta>` that says otherwise.
 */
export function decodePageBytes(bytes: Uint8Array): { text: string; charset: string } {
  const bom = bomOf(bytes);
  const label = bom?.label ?? declaredLabel(bytes) ?? 'utf-8';
  const body = bom ? bytes.subarray(bom.skip) : bytes;
  try {
    const decoder = new TextDecoder(label);
    return { text: decoder.decode(body), charset: decoder.encoding };
  } catch {
    return { text: new TextDecoder('utf-8').decode(body), charset: 'utf-8' };
  }
}

/**
 * The content type the upload endpoint needs (it assumes HTML when none is sent). A file is told by its extension; pasted
 * text (`fileName` null) by what it looks like: markup tags mean HTML, a heading or list marker means markdown, else text.
 */
export function contentTypeOf(fileName: string | null, text: string): PageContentType {
  const ext = fileName ? /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() : undefined;
  if (ext === 'md' || ext === 'markdown') return 'text/markdown';
  if (ext === 'txt') return 'text/plain';
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return 'text/html';
  const head = text.slice(0, 20_000);
  if (/<\s*(?:!doctype\s+html|html|head|body|div|p|a|h[1-6]|ul|ol|li|table|article|section|span|script|meta|title)\b/i.test(head)) return 'text/html';
  if (/^\s{0,3}(?:#{1,6}\s+\S|[-*]\s+\S|\d+\.\s+\S)/m.test(head)) return 'text/markdown';
  return 'text/plain';
}
