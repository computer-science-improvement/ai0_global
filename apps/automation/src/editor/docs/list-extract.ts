import type { DocCodeBlock, DocImage, DocLink, DocSection, StoredDoc } from './doc-types';
import { valuePresent } from '../../data/post-requires';
import { prettyJson, recordHeading } from './doc-json';
import { isBadgeImage } from './markdown-doc';

/**
 * Spec 065 FR-003: a list page becomes records in code. One record per section of a chosen heading level (its deeper
 * sections belong to it); `mapping` names, per dataset field, how to read a value out of the record. The model chooses
 * the mapping after reading the entries; nothing here calls it.
 */
export class ExtractError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export type FilterScalar = string | number | boolean | null;

export interface ListFilter {
  /** Keep entries whose heading matches this regular expression (case-insensitive). */
  heading_matches?: string;
  /** Drop entries whose heading matches. */
  heading_excludes?: string;
  has_code_block?:  boolean;
  has_image?:       boolean;
  /** Drop entries whose text contains this (case-insensitive), e.g. «Sponsor». For a JSON record: over its JSON text. */
  not_containing?:  string;
  /** JSON records only (spec 066): keep a record whose value at each path equals one of the given values (strings without case). */
  where?:           Record<string, FilterScalar | FilterScalar[]>;
  /** JSON records only: keep a record whose paths all hold a value. */
  has?:             string[];
}

/** An entry: its heading section and the deeper ones under it, read as one. */
export interface ListEntry {
  id:      string;
  heading: string;
  level:   number;
  text:    string;
  start:   number;
  images:  DocImage[];
  links:   DocLink[];
  blocks:  DocCodeBlock[];
  /** A record of a JSON document (spec 066): `text` is its pretty-printed JSON, `heading` its label; no images, links or blocks. */
  record?: unknown;
}

export const EXTRACTORS = [
  'heading', 'heading_raw', 'first_code_block', 'code_block:<n>', 'first_image', 'last_image', 'image:<n>', 'first_paragraph',
  'link_after:<label>', 'link_text_after:<label>', 'last_link_after:<label>', 'line_after:<label>', 'regex:<pattern>', 'const:<value>',
] as const;

export const JSON_EXTRACTORS = ['field:<path>', 'first_of:<path>|<path>', 'const:<value>', 'regex:<pattern>'] as const;
const SHARED = new Set(['const', 'regex']);
const JSON_ONLY = new Set(['field', 'first_of']);
const MARKDOWN_NAMES = new Set(EXTRACTORS.map((x) => x.split(':')[0]));

/** Leading outline numbers («1.1. », «10.3 ») are not part of an entry's name: they shift when entries are added. */
const NUMBERING = /^\d+(?:\.\d+)*\.?\s+/;

export const stripNumbering = (heading: string): string => heading.replace(NUMBERING, '').trim();

const pattern = (src: string, flags: string, what: string): RegExp => {
  if (src.length > 200) throw new ExtractError('bad_pattern', `${what}: pattern longer than 200 characters`);
  try { return new RegExp(src, flags); } catch (err: any) { throw new ExtractError('bad_pattern', `${what}: ${err.message}`); }
};

/** The headings level that holds the entries: the one whose sections most often hold a code block (else a picture). */
export function entryLevel(doc: StoredDoc): number | null {
  for (const own of [(s: DocSection) => s.code_blocks.length > 0, (s: DocSection) => s.images.length > 0]) {
    const count = new Map<number, number>();
    for (const s of doc.sections) if (s.level > 0 && own(s)) count.set(s.level, (count.get(s.level) ?? 0) + 1);
    const best = [...count.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    if (best && best[1] >= 2) return best[0];
  }
  return null;
}

/** Every entry of a heading level, in document order. Sections of a deeper level join the entry above them. */
export function entriesOf(doc: StoredDoc, level: number): ListEntry[] {
  const out: ListEntry[] = [];
  let cur: { head: DocSection; parts: DocSection[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const parts = cur.parts;
    out.push({
      id: cur.head.id, heading: cur.head.heading, level, start: parts[0].start,
      text: doc.text.slice(parts[0].start, parts[parts.length - 1].end),
      images: parts.flatMap((p) => p.images), links: parts.flatMap((p) => p.links), blocks: parts.flatMap((p) => p.code_blocks),
    });
    cur = null;
  };
  for (const s of doc.sections) {
    if (s.level === level) { flush(); cur = { head: s, parts: [s] }; }
    else if (cur && s.level > level) cur.parts.push(s);
    else flush();   // a shallower heading (or the intro) ends the entry
  }
  flush();
  return out;
}

/** Entries kept by the filter, plus how many it dropped. */
export function filterEntries(entries: ListEntry[], filter: ListFilter | undefined): { kept: ListEntry[]; dropped: number } {
  if (!filter) return { kept: entries, dropped: 0 };
  const json = entries.length > 0 && entries[0].record !== undefined;
  const heading = (['heading_matches', 'heading_excludes', 'has_code_block', 'has_image'] as const).filter((k) => filter[k] !== undefined);
  const record = (['where', 'has'] as const).filter((k) => filter[k] !== undefined);
  if (json && heading.length) throw new ExtractError('wrong_filter', `${heading.join(', ')} filter markdown headings; this document is JSON: use where, has or not_containing`);
  if (!json && entries.length && record.length) throw new ExtractError('wrong_filter', `${record.join(', ')} filter JSON records; this list is markdown: use heading_matches, heading_excludes, has_code_block, has_image or not_containing`);
  const match = filter.heading_matches ? pattern(filter.heading_matches, 'i', 'filter.heading_matches') : null;
  const exclude = filter.heading_excludes ? pattern(filter.heading_excludes, 'i', 'filter.heading_excludes') : null;
  const bad = filter.not_containing?.toLowerCase();
  const where = Object.entries(filter.where ?? {}).map(([path, want]) => ({ steps: parsePath(path, `filter.where.${path}`), want: Array.isArray(want) ? want : [want] }));
  const has = (filter.has ?? []).map((path) => ({ steps: parsePath(path, `filter.has ${path}`) }));
  const kept = entries.filter((e) =>
    (!match || match.test(e.heading))
    && (!exclude || !exclude.test(e.heading))
    && (filter.has_code_block === undefined || (e.blocks.length > 0) === filter.has_code_block)
    && (filter.has_image === undefined || (pictures(e).length > 0) === filter.has_image)
    && (!bad || !e.text.toLowerCase().includes(bad))
    && where.every((w) => whereMatches(leafValues(e.record, w.steps), w.want))
    && has.every((h) => leafValues(e.record, h.steps).some(valuePresent)));
  return { kept, dropped: entries.length - kept.length };
}

const pictures = (e: ListEntry): DocImage[] => e.images.filter((i) => !isBadgeImage(i.src));

const plain = (s: string): string => s
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '')
  .replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();

const inBlock = (e: ListEntry, at: number): boolean => e.blocks.some((b) => at >= b.start && at < b.end);

/** The paragraph that follows «Label:» (a line of its own, possibly in italics or bold), with where it sits in the document. */
function afterLabel(e: ListEntry, label: string): { text: string; from: number; to: number } | null {
  const re = new RegExp(`(?:^|\\n)[ \\t>*_-]*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t*_]*[:：]?`, 'ig');
  for (const m of e.text.matchAll(re)) {
    const at = e.start + m.index!;
    if (inBlock(e, at + 1)) continue;
    const bodyStart = m.index! + m[0].length;
    const rest = e.text.slice(bodyStart);
    const end = rest.search(/\n[ \t]*\n/);
    const text = end < 0 ? rest : rest.slice(0, end);
    return { text, from: e.start + bodyStart, to: e.start + bodyStart + text.length };
  }
  return null;
}

/** Paragraphs of prose in the entry: code blocks, headings, tables, pictures and bare «**Prompt:**» labels left out. */
function paragraphs(e: ListEntry): string[] {
  let text = e.text;
  for (const b of [...e.blocks].sort((a, b) => b.start - a.start)) text = text.slice(0, b.start - e.start) + text.slice(b.end - e.start);
  // Heading and table lines are not prose; what is left is cut into paragraphs at blank lines.
  text = text.split('\n').filter((l) => !/^\s*(#{1,6}\s|\|)/.test(l)).join('\n');
  return text.split(/\n[ \t]*\n/).map((p) => plain(p.replace(/^[ \t]*>[ \t]?/gm, ''))).filter((p) => {
    if (!p || /^[-*_]{3,}$/.test(p) || /^(?:source|джерело)\s*:/i.test(p)) return false;
    return !/^[^:\n]{1,40}:$/.test(p);   // a bare label such as «Prompt:»
  });
}

const n = (spec: string, what: string): number => {
  const v = Number.parseInt(spec, 10);
  if (!Number.isInteger(v) || v < 1) throw new ExtractError('bad_extractor', `${what}: a position from 1`);
  return v;
};

/** One value of an entry; null when the entry has none. Throws `ExtractError` for an extractor that does not exist. */
export function extractValue(spec: string, e: ListEntry): string | null {
  const colon = spec.indexOf(':');
  const name = colon < 0 ? spec : spec.slice(0, colon);
  const arg = colon < 0 ? '' : spec.slice(colon + 1);
  const json = e.record !== undefined;
  if (json && !SHARED.has(name) && !JSON_ONLY.has(name) && MARKDOWN_NAMES.has(name)) {
    throw new ExtractError('wrong_extractor', `"${spec}" reads a markdown list; this document is JSON: use ${JSON_EXTRACTORS.join(', ')}`);
  }
  if (!json && JSON_ONLY.has(name)) {
    throw new ExtractError('wrong_extractor', `"${spec}" reads a JSON document; this list is markdown: use ${EXTRACTORS.join(', ')}`);
  }
  const need = () => { if (!arg.trim()) throw new ExtractError('bad_extractor', `${name}: needs an argument (${name}:<…>)`); return arg.trim(); };
  const text = (v: string | undefined | null) => (v && v.trim() ? v : null);
  switch (name) {
    case 'heading':          return text(stripNumbering(e.heading));
    case 'heading_raw':      return text(e.heading);
    case 'first_code_block': return text(e.blocks[0]?.text.replace(/\s+$/, ''));
    case 'code_block':       return text(e.blocks[n(need(), spec) - 1]?.text.replace(/\s+$/, ''));
    case 'first_image':      return pictures(e)[0]?.src ?? null;
    case 'last_image':       return pictures(e).at(-1)?.src ?? null;
    case 'image':            return pictures(e)[n(need(), spec) - 1]?.src ?? null;
    case 'first_paragraph':  return text(paragraphs(e)[0]);
    case 'link_after':
    case 'link_text_after':
    case 'last_link_after': {
      const p = afterLabel(e, need());
      if (!p) return null;
      const links = e.links.filter((l) => l.at >= p.from && l.at < p.to);
      const link = name === 'last_link_after' ? links.at(-1) : links[0];
      return name === 'link_text_after' ? text(link?.text) : link?.url ?? null;
    }
    case 'line_after': {
      const p = afterLabel(e, need());
      return p ? text(plain(p.text).slice(0, 300)) : null;
    }
    case 'regex': {
      const m = pattern(need(), 'im', spec).exec(e.text);
      return m ? text((m[1] ?? m[0]).trim()) : null;
    }
    case 'const': return text(arg);
    case 'field': return fieldValue(e.record, need(), spec);
    case 'first_of': {
      for (const path of need().split('|')) {
        const v = fieldValue(e.record, path.trim(), spec);
        if (v !== null) return v;
      }
      return null;
    }
    default: throw new ExtractError('bad_extractor', `unknown extractor "${spec}"; use ${(json ? JSON_EXTRACTORS : EXTRACTORS).join(', ')}`);
  }
}

/** Every value of a mapping for one entry (fields with no value are left out). */
export function extractRow(mapping: Record<string, string>, e: ListEntry): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(mapping)) {
    const v = extractValue(spec, e);
    if (v !== null) row[field] = v;
  }
  return row;
}

// ── JSON records (spec 066 FR-002) ─────────────────────────────────────────────────────────────────────────────────────

/** The records of a JSON document as entries: `text` is each record's JSON, `heading` its label (title, name, slug, id, or `#n`). */
export function jsonEntries(records: unknown[]): ListEntry[] {
  return records.map((r, i) => ({
    id: `r${i + 1}`, level: 1, start: 0, images: [], links: [], blocks: [], record: r,
    heading: r && typeof r === 'object' && !Array.isArray(r) ? recordHeading(r as Record<string, unknown>, i + 1) : `#${i + 1}`,
    text: prettyJson(r),
  }));
}

type Step = { key: string } | { at: number } | 'all';

/** `a.b[0].c`, `tags[].name`: dot keys, `[n]` indexes an array, `[]` maps over it. */
export function parsePath(path: string, what: string): Step[] {
  const steps: Step[] = [];
  const src = path.trim();
  if (!src) throw new ExtractError('bad_extractor', `${what}: a path is needed (e.g. author.name)`);
  for (const part of src.split('.')) {
    const m = /^([^.[\]]*)((?:\[\d*\])*)$/.exec(part);
    if (!m || (!m[1] && !m[2])) throw new ExtractError('bad_extractor', `${what}: cannot read the path "${path}" (use keys joined by dots, [n] for an array item, [] for every item)`);
    if (m[1]) steps.push({ key: m[1] });
    for (const b of m[2].matchAll(/\[(\d*)\]/g)) steps.push(b[1] === '' ? 'all' : { at: Number(b[1]) });
  }
  return steps;
}

/** Every value a path reaches (several after `[]`). A missing key or index reaches nothing. */
function leafValues(record: unknown, steps: Step[]): unknown[] {
  let cur: unknown[] = [record];
  for (const st of steps) {
    const next: unknown[] = [];
    for (const v of cur) {
      if (st === 'all') { if (Array.isArray(v)) next.push(...v); }
      else if ('at' in st) { if (Array.isArray(v) && st.at < v.length) next.push(v[st.at]); }
      else if (v && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, st.key)) next.push((v as Record<string, unknown>)[st.key]);
    }
    cur = next;
  }
  return cur;
}

/** A value as text: strings, numbers and booleans; null for nothing, a blank string or an object. A list of scalars joins with ", ". */
function valueText(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() ? v : null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const parts = v.map(valueText).filter((x): x is string => x !== null);
    return parts.length ? parts.join(', ') : null;
  }
  return null;
}

function fieldValue(record: unknown, path: string, spec: string): string | null {
  const parts = leafValues(record, parsePath(path, spec)).map(valueText).filter((x): x is string => x !== null);
  return parts.length ? parts.join(', ') : null;
}

const scalarText = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : String(v));

/** `where`: one of the wanted values equals a value found at the path; a wanted null matches a path with nothing. */
function whereMatches(found: unknown[], want: FilterScalar[]): boolean {
  const have = found.filter((v) => v !== null && v !== undefined && !(typeof v === 'string' && !v.trim()));
  return want.some((w) => (w === null ? have.length === 0 : have.some((v) => scalarText(v) === scalarText(w))));
}
