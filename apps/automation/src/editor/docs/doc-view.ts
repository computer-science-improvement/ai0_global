import { TEXT_MAX } from '../net/extract-page';
import type { DocCodeBlock, DocSection, StoredDoc } from './doc-types';

/**
 * Spec 065 FR-001: what the model sees of a stored document — an outline, a page of text that never ends inside a code
 * block, and matching snippets.
 */

/** A page of text is at most this long (and `read_doc` cannot be asked for more). */
export const READ_MAX_CHARS = 6_000;
/** A text longer than this (or a markdown file with several sections) is read through an outline. */
export const LARGE_DOC_CHARS = TEXT_MAX;
/** The first chunk web_fetch returns with the outline. */
export const FIRST_CHUNK_CHARS = 3_000;
/** A code block this long still comes whole when a page starts on it; a longer one is split at a line (and flagged). */
const WHOLE_BLOCK_MAX = 12_000;
/** The outline lists at most this many sections. */
export const OUTLINE_MAX = 80;
const HEADING_CLIP = 80;
const SNIPPET_RADIUS = 300;

export interface OutlineEntry { id: string; heading: string; level: number; chars: number; code_blocks: number; images: number }

export function outlineOf(doc: StoredDoc): { outline: OutlineEntry[]; more: number } {
  const outline = doc.sections.slice(0, OUTLINE_MAX).map((s) => ({
    id: s.id,
    heading: (s.heading || '(intro)').length > HEADING_CLIP ? `${(s.heading || '(intro)').slice(0, HEADING_CLIP - 1)}…` : (s.heading || '(intro)'),
    level: s.level, chars: s.end - s.start, code_blocks: s.code_blocks.length, images: s.images.length,
  }));
  return { outline, more: Math.max(0, doc.sections.length - outline.length) };
}

/** The section named by an id (`s12`) or, failing that, by its heading (exact, then a substring). */
export function findSection(doc: StoredDoc, ref: string): DocSection | null {
  const key = ref.trim();
  const byId = doc.sections.find((s) => s.id === key);
  if (byId) return byId;
  const low = key.toLowerCase();
  return doc.sections.find((s) => s.heading.toLowerCase() === low)
    ?? doc.sections.find((s) => low.length >= 3 && s.heading.toLowerCase().includes(low)) ?? null;
}

const blocksOf = (doc: StoredDoc): DocCodeBlock[] => doc.sections.flatMap((s) => s.code_blocks);

/** A cut point in plain text: after the last paragraph (else line) break in the final quarter of the window. */
function softCut(text: string, from: number, end: number): number {
  const lo = from + Math.floor((end - from) * 0.75);
  const win = text.slice(lo, end);
  const para = win.lastIndexOf('\n\n');
  if (para >= 0) return lo + para + 2;
  const line = win.lastIndexOf('\n');
  return line >= 0 ? lo + line + 1 : end;
}

export interface DocPage {
  from:        number;
  to:          number;
  text:        string;
  /** Where to continue (absolute offset), null at the end of the range. */
  next_from:   number | null;
  /** A code block longer than the limit had to be split at a line; its fences are not both here. */
  split_block?: true;
}

/**
 * Text of `[from, limit)` of the document, at most `max` characters, ending where it does not cut a code block: before
 * the block, or after it when the block comes whole within the limit of a page that starts on it.
 */
export function pageOf(doc: StoredDoc, from: number, limit: number, max: number): DocPage {
  const text = doc.text;
  const start = Math.min(Math.max(0, from), limit);
  let end = Math.min(start + max, limit);
  let split = false;
  if (end < limit) {
    const blk = blocksOf(doc).find((b) => b.start < end && end < b.end);
    if (blk) {
      // Not much text before the block: take the block whole; else stop before it (the next page starts on it).
      if (blk.start - start < max * 0.2 && blk.end - start <= WHOLE_BLOCK_MAX) end = Math.min(blk.end, limit);
      else if (blk.start > start) end = blk.start;
      else {
        const cut = text.lastIndexOf('\n', end - 1);
        end = cut > start ? cut + 1 : end;
        split = true;
      }
    } else {
      end = softCut(text, start, end);
    }
  }
  return { from: start, to: end, text: text.slice(start, end), next_from: end < limit ? end : null, ...(split ? { split_block: true as const } : {}) };
}

/** The first chunk of a large document. */
export const firstChunk = (doc: StoredDoc): DocPage => pageOf(doc, 0, doc.text.length, FIRST_CHUNK_CHARS);

const sectionAt = (doc: StoredDoc, at: number): DocSection | undefined => doc.sections.find((s) => at >= s.start && at < s.end);

export interface DocMatch { section: string | null; heading: string | null; offset: number; snippet: string }

const tokens = (q: string) => [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2))];

/**
 * Snippets (±300 characters) around where `query` occurs: the whole phrase case-insensitively; when it occurs nowhere,
 * the places where every word of it occurs within a snippet's reach.
 */
export function findIn(doc: StoredDoc, query: string, limit: number): { total: number; matches: DocMatch[] } {
  const text = doc.text;
  const low = text.toLowerCase();
  const q = query.trim().toLowerCase();
  const hits: number[] = [];
  if (q) for (let i = low.indexOf(q); i >= 0 && hits.length < 500; i = low.indexOf(q, i + q.length)) hits.push(i);
  if (!hits.length) {
    const words = tokens(query);
    if (words.length > 1) {
      // A place counts when each word occurs within the radius around the first word's occurrence.
      for (let i = low.indexOf(words[0]); i >= 0 && hits.length < 500; i = low.indexOf(words[0], i + words[0].length)) {
        const win = low.slice(Math.max(0, i - SNIPPET_RADIUS), i + SNIPPET_RADIUS);
        if (words.every((w) => win.includes(w))) hits.push(i);
      }
    }
  }
  const matches: DocMatch[] = [];
  let lastEnd = -1;
  let total = 0;
  for (const at of hits) {
    if (at < lastEnd) continue;   // inside the previous snippet
    total++;
    lastEnd = at + SNIPPET_RADIUS;
    if (matches.length >= limit) continue;
    const s = sectionAt(doc, at);
    matches.push({
      section: s?.id ?? null, heading: s ? s.heading || '(intro)' : null, offset: at,
      snippet: text.slice(Math.max(0, at - SNIPPET_RADIUS), Math.min(text.length, at + Math.max(q.length, 1) + SNIPPET_RADIUS)),
    });
  }
  return { total, matches };
}
