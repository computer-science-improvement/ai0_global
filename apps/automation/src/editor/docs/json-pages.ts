import { isFetchFailure, type FetchFailure } from '../net/host-failures';
import { detectPagination, recordsAt } from './doc-json';
import { fetchJsonPage, type FetchDocDeps } from './doc-fetch';
import type { StoredDoc } from './doc-types';

/**
 * Spec 066 FR-003: the pages of a paged JSON API. The Apply of an import (and a re-sync) reads them one after another,
 * fresh, through the host guard, about half a second apart, without putting them in the document store. It stops at the
 * last page, at the `pages` the model asked for, at the caps (IMPORT_MAX_PAGES / IMPORT_MAX_ROWS), at a page that fails
 * (what was read is still imported) or — for a re-sync — after the first page that adds nothing new.
 */
export const IMPORT_MAX_PAGES_DEFAULT = 30;
export const IMPORT_MAX_ROWS_DEFAULT = 3_000;
/** Pause between two page requests. */
export const PAGE_DELAY_MS = 500;

export interface ImportCaps { maxPages: number; maxRows: number }

const intSetting = (v: string | undefined, def: number, lo: number, hi: number): number => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isInteger(n) && n >= lo && n <= hi ? n : def;
};

/** The caps from settings; `process.env` is the fallback, because the settings overlay writes there before the app is built. */
export function importCaps(env?: (key: string) => string | undefined): ImportCaps {
  const get = (k: string) => env?.(k) ?? process.env[k];
  return {
    maxPages: intSetting(get('IMPORT_MAX_PAGES'), IMPORT_MAX_PAGES_DEFAULT, 1, 500),
    maxRows: intSetting(get('IMPORT_MAX_ROWS'), IMPORT_MAX_ROWS_DEFAULT, 100, 20_000),
  };
}

export type StopReason = 'single' | 'last_page' | 'pages' | 'max_pages' | 'max_rows' | 'no_new' | 'failed';

export interface PagingInfo {
  pages_read:    number;
  pages_total:   number | null;
  records_total: number | null;
  stopped:       StopReason;
  /** Why a page could not be read (`status 429`); the run kept what came before it. */
  failure?:      string;
}

/** What one page is worth: how many of its entries passed the filter, and the refs of the rows it would write. */
export interface PageMeasure { kept: number; refs: string[] }

export interface ReadPagesOptions {
  /** The model's `pages` argument. */
  pages?:   number;
  caps:     ImportCaps;
  delayMs:  number;
  measure:  (records: unknown[]) => PageMeasure;
  /** Re-sync: of these refs, the ones the dataset already has. Given = stop after the first page with nothing new. */
  known?:   (refs: string[]) => Promise<Set<string>>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `status 429` of a refusal; the error name of anything else. */
export function failureText(f: FetchFailure): string {
  return /^status \d+/.exec(f.details)?.[0] ?? `${f.error}${f.details ? `: ${f.details.slice(0, 80)}` : ''}`;
}

/** The records of every page, in order, starting from the stored first page, and how the reading ended. */
export async function readPages(first: StoredDoc, d: Pick<FetchDocDeps, 'http' | 'hosts' | 'sources'>, o: ReadPagesOptions): Promise<{ records: unknown[]; paging: PagingInfo }> {
  const path = first.json?.records_path ?? '';
  const records: unknown[] = [...(first.json?.records ?? [])];
  let pg = detectPagination(first.json?.value, first.url);
  const pagesTotal = pg?.pages_total ?? null;
  const recordsTotal = pg?.records_total ?? null;
  const seen = new Set([first.url]);
  let pageRecords: unknown[] = records;
  let pagesRead = 0;
  let kept = 0;
  let stopped: StopReason = 'single';
  let failure: string | undefined;
  for (;;) {
    pagesRead++;
    const m = o.measure(pageRecords);
    kept += m.kept;
    if (o.known && m.refs.length) {
      const have = await o.known(m.refs);
      if (m.refs.every((r) => have.has(r))) { stopped = 'no_new'; break; }
    }
    const next = pg?.next_url ?? null;
    if (!next) { stopped = pg ? 'last_page' : 'single'; break; }
    if (kept >= o.caps.maxRows) { stopped = 'max_rows'; break; }
    if (o.pages !== undefined && pagesRead >= o.pages) { stopped = 'pages'; break; }
    if (pagesRead >= o.caps.maxPages) { stopped = 'max_pages'; break; }
    if (seen.has(next)) { stopped = 'last_page'; break; }   // an API that points back at a page it already gave
    seen.add(next);
    if (o.delayMs > 0) await sleep(o.delayMs);
    let page: Awaited<ReturnType<typeof fetchJsonPage>>;
    try {
      page = await fetchJsonPage(next, d);
    } catch (err: any) {
      failure = String(err?.message ?? err).slice(0, 120);
      stopped = 'failed';
      break;
    }
    if (isFetchFailure(page)) { failure = failureText(page); stopped = 'failed'; break; }
    const recs = recordsAt(page.value, path);
    pg = detectPagination(page.value, page.url);
    if (!recs.length) { stopped = 'last_page'; break; }
    records.push(...recs);
    pageRecords = recs;
  }
  return {
    records,
    paging: { pages_read: pagesRead, pages_total: pagesTotal ?? (stopped === 'last_page' ? pagesRead : null), records_total: recordsTotal, stopped, ...(failure ? { failure } : {}) },
  };
}

export interface PagingPreview {
  kind:           string;
  pages_total:    number | null;
  records_total:  number | null;
  /** How many pages Apply will read (a cap when the total is not known). */
  pages_to_read:  number;
  notes:          string[];
}

/** What the preview says about the pages: from the first page alone, no request. */
export function pagingPreview(doc: StoredDoc, o: { pages?: number; caps: ImportCaps }): PagingPreview {
  const pg = detectPagination(doc.json?.value, doc.url);
  const notes: string[] = [];
  if (!pg) return { kind: 'none', pages_total: 1, records_total: null, pages_to_read: 1, notes: ['no pagination found in the answer: one page'] };
  const cap = Math.min(o.pages ?? Infinity, o.caps.maxPages);
  const remaining = pg.pages_total !== null ? Math.max(1, pg.pages_total - (pg.page ?? 1) + 1) : null;
  const toRead = !pg.next_url ? 1 : remaining !== null ? Math.min(remaining, cap) : cap;
  if (pg.next_url && remaining === null) notes.push(`the total number of pages is not known (${pg.kind === 'cursor' ? 'cursor' : 'next link'}): Apply reads up to ${toRead} pages, until the last one`);
  if (remaining !== null && remaining > toRead) {
    notes.push(`the API has ${remaining} pages${pg.records_total !== null ? ` (${pg.records_total} records)` : ''} but Apply reads ${toRead} (${o.pages !== undefined && o.pages <= o.caps.maxPages ? 'pages argument' : `cap IMPORT_MAX_PAGES = ${o.caps.maxPages}`}); `
      + 'narrow the request with the API\'s own parameters (e.g. ?type=IMAGE, ?perPage=100) or raise the cap in Settings');
  }
  if (pg.records_total !== null && pg.records_total > o.caps.maxRows) notes.push(`${pg.records_total} records in total: Apply stops once ${o.caps.maxRows} entries have passed the filter (IMPORT_MAX_ROWS)`);
  return { kind: pg.kind, pages_total: pg.pages_total, records_total: pg.records_total, pages_to_read: toRead, notes };
}

/** The owner-facing line of what was read, for an Apply that did not simply reach the last page. */
export function pagingNote(p: PagingInfo, o: { pages?: number; caps: ImportCaps }): string | null {
  const of = p.pages_total ?? '?';
  switch (p.stopped) {
    case 'failed': return `прочитано ${p.pages_read} з ${of} сторінок: ${p.failure ?? 'помилка'}`;
    case 'max_pages': return `прочитано ${p.pages_read} з ${of} сторінок (ліміт IMPORT_MAX_PAGES = ${o.caps.maxPages})`;
    case 'pages': return `прочитано ${p.pages_read} з ${of} сторінок (pages = ${o.pages})`;
    case 'max_rows': return `прочитано ${p.pages_read} з ${of} сторінок: досягнуто ліміту ${o.caps.maxRows} записів (IMPORT_MAX_ROWS)`;
    default: return null;
  }
}
