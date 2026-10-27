import type { DocStore } from '../docs/doc-store';

/**
 * Spec 067 FR-001: what the author read, as the critic and lint see it.
 *
 * The gate wraps the run's read tools; this keeps their output per page and per document and answers one question for
 * all three readers — lint (`number_not_in_sources`), the critic's code grounding block and the text the critic is
 * shown: `readTextOf(url)`. They always agree because they all call it.
 *
 * Coverage says how much of the cited source the text is:
 *   - `full`: the whole page (a short page, or a document in the store up to FULL_PAGE_MAX), so what is not there is
 *     not in the source;
 *   - `read`: only what the author read of a bigger document (the first chunk, `read_doc` pages and `find_in_doc`
 *     snippets, merged), so what is not there may be anywhere else in it — grounding 3 with a note, not ≤ 2;
 *   - `snippet`: a feed item's title and text;
 *   - `none`: nothing of it was read.
 *
 * Never ground on the whole text of a large document the author did not read (e.g. the 270k traffic code): on a legal
 * code nearly every number occurs somewhere, so that would hide invented numbers.
 */

/** Order: none < snippet < read < full. */
export type SourceCoverage = 'none' | 'snippet' | 'read' | 'full';
const ORDER: Record<SourceCoverage, number> = { none: 0, snippet: 1, read: 2, full: 3 };

/** The lower of two coverages (the lowest among the cited sources is the one stored). */
export const lowerCoverage = (a: SourceCoverage, b: SourceCoverage): SourceCoverage => (ORDER[a] <= ORDER[b] ? a : b);

/** A page or document up to this long is given to the critic whole. */
export const FULL_PAGE_MAX = 12_000;
/** Spec 037 T4: a page read in the run is kept up to this, for grounding and the critic's passages. */
export const PAGE_CAP = 60_000;
/** Between two separate parts of a document in one text, so numbers at their edges never fuse into one value. */
export const SPAN_GAP = '\n…\n';
/** The snippet radius of `find_in_doc` (docs/doc-view.ts), to rebuild a match's span from its offset. */
const SNIPPET_RADIUS = 300;

const normUrl = (u: string): string => u.trim().replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
const str = (x: unknown): x is string => typeof x === 'string';

/** A part of a document the author read: `[from, to)` of the document text, with the text as the tool gave it. */
export interface ReadSpan { from: number; to: number; text: string }

interface CapturedDoc {
  id:        string;
  /** The `fetched_at` of the copy the spans were read from; null when the store could not say. */
  copy:      number | null;
  size:      number | null;
  /** Title and description of the page (web_fetch), which come before the text. */
  head:      string;
  spans:     ReadSpan[];
}

/** The text read of one source, by `readTextOf`. */
export interface ReadText {
  text:     string;
  coverage: SourceCoverage;
  /** The size of the whole page or document in characters. */
  size:     number;
  /** `read` only: the merged parts of the document the author read, in document order. */
  spans?:   ReadSpan[];
  /** Characters of the parts read (without the head). */
  chars:    number;
}

/** Sort the spans by offset and merge those that overlap or touch (the text of the later one fills in the rest). */
export function mergeSpans(spans: readonly ReadSpan[]): ReadSpan[] {
  const sorted = spans.filter((s) => s.text).sort((a, b) => a.from - b.from || b.to - a.to);
  const out: ReadSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.from <= last.to) {
      if (s.to > last.to) { last.text += s.text.slice(last.to - s.from); last.to = s.to; }
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

export class ReadCapture {
  /** web_fetch pages that came whole (no doc_id): title + description + text, ≤ PAGE_CAP. */
  private readonly pages = new Map<string, string>();
  /** fetch_feed items: title, date and snippet. */
  private readonly feed = new Map<string, string>();
  private readonly docOfUrl = new Map<string, string>();
  private readonly docs = new Map<string, CapturedDoc>();

  /** `store` is the store the doc tools use; the gate never makes one (spec 070 changes its lifetime rules). */
  constructor(private readonly store?: Pick<DocStore, 'get' | 'urlOf'>) {}

  /** The copy of the document the store holds right now (its `fetched_at`), null when it holds none. */
  private copyOf(id: string): number | null {
    try { return this.store?.get(id)?.fetched_at ?? null; } catch { return null; }
  }

  /** The captured entry of a document. A new copy under the same id (another fetch replaced it) starts again: offsets of two copies do not mix. */
  private entry(id: string, copy: number | null): CapturedDoc {
    const have = this.docs.get(id);
    if (have && (copy == null || have.copy == null || have.copy === copy)) {
      if (have.copy == null) have.copy = copy;
      return have;
    }
    const d: CapturedDoc = { id, copy, size: null, head: '', spans: [] };
    this.docs.set(id, d);
    return d;
  }

  /** web_fetch: a whole page, or the first chunk of a document with its `doc_id`. */
  webFetch(input: any, out: any): void {
    const urls = [input?.url, out?.url].filter(str);
    const head = [out?.title, out?.description].filter((x): x is string => str(x) && !!x.trim()).join('\n');
    if (str(out?.doc_id)) {
      const d = this.entry(out.doc_id, this.copyOf(out.doc_id));
      for (const u of urls) this.docOfUrl.set(normUrl(u), out.doc_id);
      if (typeof out.size_chars === 'number') d.size = out.size_chars;
      d.head = head;
      // A JSON answer has the doc_id and the shape of the records, no text: nothing was read yet.
      if (str(out.text) && out.text) d.spans.push({ from: 0, to: out.text.length, text: out.text });
      return;
    }
    const text = [out?.title, out?.description, out?.text].filter((x): x is string => str(x) && !!x.trim()).join('\n');
    if (text) for (const u of urls) this.pages.set(normUrl(u), text.slice(0, PAGE_CAP));
  }

  /** read_doc: `[from, to)` of a document. Returns the document's address when it was not seen before (the gate adds it to what the run read). */
  readDoc(input: any, out: any): string | null {
    const id = str(out?.doc_id) ? out.doc_id : str(input?.doc_id) ? input.doc_id : null;
    if (!id || !str(out?.text) || !out.text || typeof out.from !== 'number') return null;
    const d = this.known(id, this.copyOf(id));
    if (!d) return null;
    if (typeof out.size_chars === 'number') d.doc.size = out.size_chars;
    d.doc.spans.push({ from: out.from, to: out.from + out.text.length, text: out.text });
    return d.learned;
  }

  /** find_in_doc: one span around each match (`snippet` starts 300 characters before its `offset`). */
  findInDoc(input: any, out: any): string | null {
    const id = str(out?.doc_id) ? out.doc_id : str(input?.doc_id) ? input.doc_id : null;
    if (!id || !Array.isArray(out?.matches)) return null;
    const d = this.known(id, this.copyOf(id));
    if (!d) return null;
    for (const m of out.matches) {
      if (!str(m?.snippet) || !m.snippet || typeof m.offset !== 'number') continue;
      const from = Math.max(0, m.offset - SNIPPET_RADIUS);
      d.doc.spans.push({ from, to: from + m.snippet.length, text: m.snippet });
    }
    return d.learned;
  }

  /** The entry for a doc_id the run reads from; a doc_id with no earlier web_fetch gets its address from the store. */
  private known(id: string, copy: number | null): { doc: CapturedDoc; learned: string | null } | null {
    const doc = this.entry(id, copy);
    const mapped = [...this.docOfUrl.values()].includes(id);
    if (mapped) return { doc, learned: null };
    let url: string | null = null;
    try { url = this.store?.urlOf(id) ?? null; } catch { /* the store is a helper */ }
    if (!url) return null;
    this.docOfUrl.set(normUrl(url), id);
    return { doc, learned: url };
  }

  /** fetch_feed: a feed item (title, date, snippet); a page read in full wins over it. */
  feedItem(link: string, text: string): void {
    if (text) this.feed.set(normUrl(link), text.slice(0, PAGE_CAP));
  }

  has(url: string): boolean {
    return this.readTextOf(url) !== null;
  }

  /** Every address something was read from (pages, documents and feed items), normalised. */
  keys(): string[] {
    return [...new Set([...this.pages.keys(), ...this.docOfUrl.keys(), ...this.feed.keys()])];
  }

  /**
   * The text of `url` the author read and how much of the source it is (see the module comment). Null when nothing
   * of it was read.
   */
  readTextOf(url: string): ReadText | null {
    const key = normUrl(url);
    const id = this.docOfUrl.get(key);
    const doc = id ? this.docs.get(id) : undefined;
    if (doc && doc.spans.length) return this.docText(doc);
    const page = this.pages.get(key);
    if (page) {
      return page.length <= FULL_PAGE_MAX
        ? { text: page, coverage: 'full', size: page.length, chars: page.length }
        // A page of more than 12k that came whole (it never does in production: a long page is a document).
        : { text: page, coverage: 'read', size: page.length, chars: page.length, spans: [{ from: 0, to: page.length, text: page }] };
    }
    const item = this.feed.get(key);
    return item ? { text: item, coverage: 'snippet', size: item.length, chars: item.length } : null;
  }

  private docText(d: CapturedDoc): ReadText {
    // Only the copy the spans were read from may be sliced; a newer copy under the same id has other offsets (spec 070).
    let live: string | null = null;
    try {
      const doc = this.store?.get(d.id) ?? null;
      if (doc && d.copy != null && doc.fetched_at === d.copy) live = doc.text;
    } catch { /* the captured text is enough */ }
    const merged = mergeSpans(d.spans).map((s) => (live != null && s.to <= live.length ? { from: s.from, to: s.to, text: live.slice(s.from, s.to) } : s));
    const head = d.head ? `${d.head}\n` : '';
    const size = d.size ?? (live != null ? live.length : null);
    if (size != null && size <= FULL_PAGE_MAX) {
      if (live != null) return { text: head + live, coverage: 'full', size, chars: live.length };
      if (merged.length === 1 && merged[0].from === 0 && merged[0].to >= size) return { text: head + merged[0].text, coverage: 'full', size, chars: merged[0].text.length };
    }
    const chars = merged.reduce((n, s) => n + s.text.length, 0);
    const body = merged.map((s) => s.text).join(SPAN_GAP);
    return { text: (head + body).slice(0, PAGE_CAP), coverage: 'read', size: size ?? Math.max(...merged.map((s) => s.to)), chars, spans: merged };
  }
}
