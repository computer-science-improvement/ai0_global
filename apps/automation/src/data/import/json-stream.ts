/**
 * Streaming readers for JSON imports (spec 032 FR-006), no dependencies:
 *   • parseJsonArray — a top-level JSON array of objects, element by element;
 *   • parseJsonl     — one JSON object per line.
 * A broken element or line becomes a record with `error`; parsing goes on.
 */

export interface JsonRecord {
  /** 1-based element number (array) or line number (JSONL). */
  row:    number;
  value?: Record<string, unknown>;
  error?: string;
}

type Source = AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>;

async function* decode(source: Source): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  let first = true;
  for await (const chunk of source as AsyncIterable<Uint8Array | string>) {
    let text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    if (first && text.length) { if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); first = false; }
    if (text) yield text;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

function toRecord(row: number, text: string): JsonRecord {
  let v: unknown;
  try { v = JSON.parse(text); } catch (e: any) { return { row, error: `invalid JSON: ${String(e.message).slice(0, 120)}` }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { row, error: 'row is not a JSON object' };
  return { row, value: v as Record<string, unknown> };
}

/** Elements of a top-level JSON array. Anything else at the top level is one error record. */
export async function* parseJsonArray(source: Source): AsyncGenerator<JsonRecord> {
  let phase: 'before' | 'in' | 'after' = 'before';
  let depth = 0;          // nesting inside the current element
  let inString = false;
  let escape = false;
  let buf = '';
  let row = 0;
  let trailing = false;

  for await (const text of decode(source)) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (phase === 'before') {
        if (/\s/.test(ch)) continue;
        if (ch !== '[') { yield { row: 0, error: 'expected a JSON array of objects' }; return; }
        phase = 'in';
        continue;
      }
      if (phase === 'after') {
        if (!/\s/.test(ch)) trailing = true;
        continue;
      }
      if (inString) {
        buf += ch;
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; buf += ch; continue; }
      if (ch === '{' || ch === '[') { depth++; buf += ch; continue; }
      if ((ch === '}' || ch === ']') && depth > 0) { depth--; buf += ch; continue; }
      if (depth === 0 && (ch === ',' || ch === ']')) {
        const t = buf.trim();
        if (t) yield toRecord(++row, t);
        else if (ch === ',') yield { row: ++row, error: 'empty element' };
        buf = '';
        if (ch === ']') phase = 'after';
        continue;
      }
      buf += ch;
    }
  }
  if (phase === 'in') {
    const t = buf.trim();
    if (t) yield { row: ++row, error: 'the array is not closed (truncated file?)' };
    else yield { row: row + 1, error: 'the array is not closed (truncated file?)' };
  }
  if (phase === 'before') yield { row: 0, error: 'expected a JSON array of objects' };
  if (trailing) yield { row: row + 1, error: 'unexpected text after the array' };
}

/** One JSON object per line; blank lines are skipped. */
export async function* parseJsonl(source: Source): AsyncGenerator<JsonRecord> {
  let carry = '';
  let line = 0;
  for await (const text of decode(source)) {
    carry += text;
    let nl: number;
    while ((nl = carry.indexOf('\n')) >= 0) {
      const l = carry.slice(0, nl).replace(/\r$/, '');
      carry = carry.slice(nl + 1);
      line++;
      if (l.trim()) yield toRecord(line, l);
    }
  }
  if (carry.trim()) yield toRecord(line + 1, carry.replace(/\r$/, ''));
}
