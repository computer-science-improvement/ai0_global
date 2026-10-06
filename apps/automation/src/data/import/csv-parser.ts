/**
 * Streaming CSV parser (RFC 4180) for dataset imports (spec 032 FR-006). No dependencies.
 *
 *   • UTF-8, a leading BOM is dropped; chunks may split multi-byte characters;
 *   • delimiter `,` `;` or tab, detected from the header line (outside quotes) unless given;
 *   • quoted fields with escaped quotes ("") and embedded newlines; CRLF, LF or CR line ends;
 *   • broken input never throws: a character after a closing quote, or a quote left open at the end of
 *     the file, yields a record with `error` and parsing goes on (an unclosed quote is re-read from the
 *     next line, so later rows survive);
 *   • blank lines are skipped.
 * Each record carries the 1-based line it starts on.
 */

export type CsvDelimiter = ',' | ';' | '\t';

export interface CsvRecord {
  line:   number;
  fields: string[];
  error?: string;
}

const CANDIDATES: CsvDelimiter[] = [',', ';', '\t'];

/** Count each candidate outside quotes in the first record of `sample`; ties prefer `,` then `;`. */
export function detectDelimiter(sample: string): CsvDelimiter {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (let i = 0; i < sample.length; i++) {
    const ch = sample[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (inQuotes) continue;
    if (ch === '\n' || ch === '\r') break;
    if (ch in counts) counts[ch]++;
  }
  let best: CsvDelimiter = ',';
  for (const d of CANDIDATES) if (counts[d] > counts[best]) best = d;
  return best;
}

type State = 'start' | 'unquoted' | 'quoted' | 'quote_in_quoted';

class CsvMachine {
  private state: State = 'start';
  private field = '';
  private fields: string[] = [];
  private raw = '';              // raw text of the current record (to recover from an unclosed quote)
  private error: string | undefined;
  private line: number;
  private recordLine: number;
  private skipLf = false;
  private prevCr = false;
  readonly out: CsvRecord[] = [];

  constructor(readonly delim: string, startLine = 1) {
    this.line = startLine;
    this.recordLine = startLine;
  }

  feed(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (this.skipLf) {
        this.skipLf = false;
        if (ch === '\n') continue;
      }
      this.raw += ch;
      switch (this.state) {
        case 'start':
          if (ch === '"') { this.state = 'quoted'; break; }
          if (ch === this.delim) { this.pushField(); break; }
          if (ch === '\n' || ch === '\r') { this.endRecord(ch); break; }
          this.field += ch; this.state = 'unquoted';
          break;
        case 'unquoted':
          if (ch === this.delim) { this.pushField(); this.state = 'start'; break; }
          if (ch === '\n' || ch === '\r') { this.endRecord(ch); break; }
          this.field += ch;      // a stray quote inside an unquoted field is kept literally
          break;
        case 'quoted':
          if (ch === '"') { this.state = 'quote_in_quoted'; this.prevCr = false; break; }
          // Newlines inside quotes are data; count lines (CRLF once, even across chunks).
          if (ch === '\r' || (ch === '\n' && !this.prevCr)) this.line++;
          this.prevCr = ch === '\r';
          this.field += ch;
          break;
        case 'quote_in_quoted':
          if (ch === '"') { this.field += '"'; this.state = 'quoted'; break; }
          if (ch === this.delim) { this.pushField(); this.state = 'start'; break; }
          if (ch === '\n' || ch === '\r') { this.endRecord(ch); break; }
          this.error ??= `unexpected character after a closing quote (field ${this.fields.length + 1})`;
          this.field += ch; this.state = 'unquoted';
          break;
      }
    }
  }

  /** End of input. Returns text to re-parse when a quote was left open (everything after its first line). */
  finish(): { reparse?: string; fromLine?: number } {
    if (this.state === 'quoted') {
      this.out.push({ line: this.recordLine, fields: [...this.fields, this.field.slice(0, 200)], error: 'unterminated quoted field' });
      const m = /\r\n|\n|\r/.exec(this.raw);
      if (!m) return {};
      return { reparse: this.raw.slice(m.index + m[0].length), fromLine: this.recordLine + 1 };
    }
    if (this.state !== 'start' || this.fields.length > 0 || this.field !== '') this.emit();
    return {};
  }

  private pushField(): void {
    this.fields.push(this.field);
    this.field = '';
  }

  private endRecord(ch: string): void {
    // A broken record that spans several lines is most likely an unbalanced quote that swallowed the
    // next rows: report its first line and re-read everything after it.
    const body = this.raw.slice(0, -1);
    const br = this.error ? /\r\n|\n|\r/.exec(body) : null;
    if (br) {
      const rest = this.raw.slice(br.index + br[0].length);
      this.out.push({ line: this.recordLine, fields: [body.slice(0, br.index)], error: this.error });
      this.fields = []; this.field = ''; this.raw = ''; this.error = undefined; this.state = 'start'; this.prevCr = false;
      this.line = this.recordLine + 1;
      this.recordLine = this.line;
      this.feed(rest);
      return;
    }
    this.emit();
    this.line++;
    this.recordLine = this.line;
    if (ch === '\r') this.skipLf = true;
  }

  private emit(): void {
    this.pushField();
    const blank = this.fields.length === 1 && this.fields[0] === '' && !this.error;
    if (!blank) this.out.push({ line: this.recordLine, fields: this.fields, ...(this.error ? { error: this.error } : {}) });
    this.fields = [];
    this.field = '';
    this.raw = '';
    this.error = undefined;
    this.state = 'start';
  }
}

export interface CsvOptions {
  delimiter?: CsvDelimiter;
  /** Called once with the delimiter in use. */
  onDelimiter?: (d: CsvDelimiter) => void;
}

async function* decode(source: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');   // drops a leading BOM in byte input
  let first = true;
  for await (const chunk of source as AsyncIterable<Uint8Array | string>) {
    let text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    if (first && text.length) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      first = false;
    }
    if (text) yield text;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

/** Parse a CSV stream into records (header included as the first record). */
export async function* parseCsv(
  source: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>,
  opts: CsvOptions = {},
): AsyncGenerator<CsvRecord> {
  let machine: CsvMachine | null = null;
  let head = '';
  for await (const text of decode(source)) {
    if (!machine) {
      head += text;
      // Wait for a full first line (or 64 KB) before choosing the delimiter.
      if (!/[\r\n]/.test(stripQuoted(head)) && head.length < 65_536) continue;
      const d = opts.delimiter ?? detectDelimiter(head);
      opts.onDelimiter?.(d);
      machine = new CsvMachine(d);
      machine.feed(head);
      head = '';
    } else {
      machine.feed(text);
    }
    if (machine.out.length) { for (const r of machine.out.splice(0)) yield r; }
  }
  if (!machine) {
    const d = opts.delimiter ?? detectDelimiter(head);
    opts.onDelimiter?.(d);
    machine = new CsvMachine(d);
    machine.feed(head);
  }
  let fin = machine.finish();
  for (const r of machine.out.splice(0)) yield r;
  while (fin.reparse !== undefined) {
    const m: CsvMachine = new CsvMachine(machine.delim, fin.fromLine);
    m.feed(fin.reparse);
    fin = m.finish();
    for (const r of m.out.splice(0)) yield r;
    machine = m;
  }
}

/** Text with quoted sections removed (to find the end of the header line). */
function stripQuoted(s: string): string {
  return s.replace(/"(?:[^"]|"")*"/g, '').replace(/"[^"]*$/, '');
}
