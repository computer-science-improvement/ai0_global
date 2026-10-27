import { createHash } from 'node:crypto';
import type { DocSection, RawSection, StoredDoc } from './doc-types';

/**
 * Spec 065 FR-001: web_fetch keeps the whole fetched document here, in memory: an LRU of about 100 documents that live
 * `DOC_STORE_HOURS` (default 6). `read_doc` and `find_in_doc` read it by `doc_id`; a second fetch of the same address
 * inside the lifetime is answered from it (the fetch cache). Single instance (constitution): nothing is shared.
 *
 * Spec 070 FR-003: past that lifetime a document is stale, not gone. It stays until the LRU pushes it out or it is
 * `DOC_STALE_MAX_HOURS` old: `get(doc_id)` and `keptByUrl(url)` still return it (a doc_id names the latest kept copy of its
 * address, so read_doc / find_in_doc / import_list keep working), `fresh(url)` does not (that is the fetch cache), and a
 * fetch that fails because the site is down can answer with the kept copy.
 */
export const DOC_STORE_MAX = 100;
export const DOC_STORE_DEFAULT_HOURS = 6;
/** A document is kept this long at most, fresh or not (spec 070). */
export const DOC_STALE_MAX_HOURS = 168;
/** All documents together stay under this many characters (the oldest-used go first). */
const TOTAL_CHARS_MAX = 40_000_000;
/** Addresses of documents that are gone, kept so an old doc_id can say what to fetch again. */
const TOMBSTONES_MAX = 500;

/** The key of an address: no fragment, lower-case host, no trailing slash (the root keeps its own). */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return url.trim();
  }
}

export const docIdOf = (url: string): string => `doc_${createHash('sha1').update(canonicalUrl(url)).digest('hex').slice(0, 10)}`;

export type NewDoc = Omit<StoredDoc, 'id' | 'fetched_at' | 'sections'> & { sections: RawSection[] };

export interface DocStoreOptions { max?: number; ttlHours?: number; staleHours?: number; now?: () => number }

export class DocStore {
  private readonly docs = new Map<string, StoredDoc>();
  private readonly tombstones = new Map<string, string>();
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly staleMs: number;
  private readonly now: () => number;
  private chars = 0;

  constructor(opts: DocStoreOptions = {}) {
    this.max = opts.max ?? DOC_STORE_MAX;
    this.ttlMs = (opts.ttlHours ?? DOC_STORE_DEFAULT_HOURS) * 3_600_000;
    this.staleMs = Math.max(this.ttlMs, (opts.staleHours ?? DOC_STALE_MAX_HOURS) * 3_600_000);
    this.now = opts.now ?? Date.now;
  }

  /** Keep a document under the id of the address asked for; a later fetch of it replaces the earlier copy. */
  put(input: NewDoc): StoredDoc {
    const id = docIdOf(input.url);
    this.drop(id, false);
    const sections: DocSection[] = input.sections.map((s, i) => ({ ...s, id: `s${i + 1}` }));
    const doc: StoredDoc = { ...input, sections, id, fetched_at: this.now() };
    this.docs.set(id, doc);
    this.chars += doc.text.length;
    while (this.docs.size > this.max || (this.chars > TOTAL_CHARS_MAX && this.docs.size > 1)) {
      const oldest = this.docs.keys().next().value as string;
      this.drop(oldest, true);
    }
    return doc;
  }

  /** The document a doc_id names: the latest kept copy of its address, however old, up to the stale cap. A read makes it the newest-used. */
  get(id: string): StoredDoc | null {
    return this.touch(this.peek(id));
  }

  /** The copy of an address that is within the lifetime (the fetch cache); a stale copy is not returned. */
  fresh(url: string): StoredDoc | null {
    const doc = this.peek(docIdOf(url));
    return doc && this.now() - doc.fetched_at <= this.ttlMs ? this.touch(doc) : null;
  }

  /** Any kept copy of an address, fresh or stale: what a failed fetch can fall back to. */
  keptByUrl(url: string): StoredDoc | null {
    return this.touch(this.peek(docIdOf(url)));
  }

  /** The fetch cache of before the stale copies (`fresh`). */
  getByUrl(url: string): StoredDoc | null {
    return this.fresh(url);
  }

  /** The address a gone (or still kept) doc_id stood for. */
  urlOf(id: string): string | null {
    return this.docs.get(id)?.url ?? this.tombstones.get(id) ?? null;
  }

  get size(): number {
    return this.docs.size;
  }

  /** The kept copy under an id; one past the stale cap is dropped (its address stays as a tombstone). Does not touch the LRU order. */
  private peek(id: string): StoredDoc | null {
    const doc = this.docs.get(id);
    if (!doc) return null;
    if (this.now() - doc.fetched_at > this.staleMs) {
      this.drop(id, true);
      return null;
    }
    return doc;
  }

  private touch(doc: StoredDoc | null): StoredDoc | null {
    if (doc) {
      this.docs.delete(doc.id);
      this.docs.set(doc.id, doc);
    }
    return doc;
  }

  private drop(id: string, remember: boolean): void {
    const doc = this.docs.get(id);
    if (!doc) return;
    this.docs.delete(id);
    this.chars -= doc.text.length;
    if (remember) {
      this.tombstones.set(id, doc.url);
      if (this.tombstones.size > TOMBSTONES_MAX) this.tombstones.delete(this.tombstones.keys().next().value as string);
    }
  }
}

let shared: DocStore | null = null;

/** The one store of the running service (web_fetch, read_doc, find_in_doc, import_list share it). */
export function sharedDocStore(env?: (k: string) => string | undefined): DocStore {
  if (!shared) {
    // The settings overlay runs before the app is built, so process.env has the value whoever asks first.
    const h = Number(env?.('DOC_STORE_HOURS') ?? process.env.DOC_STORE_HOURS);
    shared = new DocStore({ ttlHours: Number.isFinite(h) && h >= 1 && h <= 72 ? h : DOC_STORE_DEFAULT_HOURS });
  }
  return shared;
}
