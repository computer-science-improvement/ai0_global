import { parseCsv, type CsvDelimiter } from './csv-parser';
import { parseJsonArray, parseJsonl } from './json-stream';

/**
 * Turns an uploaded file into source rows ({column → value}) for an import, streaming through the
 * CSV / JSON / JSONL parsers. Broken rows come out as `{error}` records and never stop the read.
 */

export type ImportFormat = 'csv' | 'json' | 'jsonl';

export interface SourceRow {
  /** 1-based data row number (the CSV header is not counted). */
  row:    number;
  /** CSV: the line the record starts on. */
  line?:  number;
  value?: Record<string, unknown>;
  error?: string;
}

export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 200_000;

export function detectFormat(filename: string | undefined, head: Buffer): ImportFormat {
  const ext = (filename ?? '').toLowerCase().split('.').pop();
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return 'csv';
  if (ext === 'jsonl' || ext === 'ndjson') return 'jsonl';
  if (ext === 'json') return 'json';
  const t = head.subarray(0, 512).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (t.startsWith('[')) return 'json';
  if (t.startsWith('{')) return 'jsonl';
  return 'csv';
}

export function* chunks(buf: Buffer, size = 64 * 1024): Generator<Uint8Array> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

export interface ReadResult {
  columns:    string[];
  delimiter?: CsvDelimiter;
  /** A problem with the whole file (no header, not an array…). */
  fatal?:     string;
}

/**
 * Read rows. `meta` is filled as soon as the columns are known (CSV header, or the union of keys of the
 * JSON objects seen so far, in first-seen order).
 */
export async function* readSourceRows(buf: Buffer, format: ImportFormat, meta: ReadResult): AsyncGenerator<SourceRow> {
  if (format === 'csv') {
    let header: string[] | null = null;
    let n = 0;
    for await (const rec of parseCsv(chunks(buf), { onDelimiter: (d) => { meta.delimiter = d; } })) {
      if (!header) {
        if (rec.error) { meta.fatal = `the header line is broken: ${rec.error}`; return; }
        const seen = new Map<string, number>();
        header = rec.fields.map((h, i) => {
          const base = h.trim() || `column_${i + 1}`;
          const k = seen.get(base) ?? 0;
          seen.set(base, k + 1);
          return k ? `${base}_${k + 1}` : base;
        });
        meta.columns = header;
        continue;
      }
      n++;
      if (rec.error) { yield { row: n, line: rec.line, error: rec.error }; continue; }
      let fields = rec.fields;
      if (fields.length > header.length && fields.slice(header.length).every((f) => f === '')) fields = fields.slice(0, header.length);
      if (fields.length !== header.length) {
        yield { row: n, line: rec.line, error: `expected ${header.length} columns, found ${fields.length}` };
        continue;
      }
      const value: Record<string, unknown> = {};
      header.forEach((h, i) => { value[h] = fields[i]; });
      yield { row: n, line: rec.line, value };
    }
    if (!header) meta.fatal = 'the file is empty';
    return;
  }
  const seen = new Set<string>(meta.columns);
  const parser = format === 'json' ? parseJsonArray(chunks(buf)) : parseJsonl(chunks(buf));
  for await (const rec of parser) {
    if (rec.row === 0) { meta.fatal = rec.error ?? 'unreadable file'; return; }
    if (rec.error) { yield { row: rec.row, error: rec.error }; continue; }
    for (const k of Object.keys(rec.value!)) if (!seen.has(k)) { seen.add(k); meta.columns.push(k); }
    yield { row: rec.row, value: rec.value };
  }
}
