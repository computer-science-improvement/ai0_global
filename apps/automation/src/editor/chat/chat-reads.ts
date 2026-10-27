import type { AuditSource } from '../post/integrity/types';

/**
 * Spec 069 FR-007: what the chat's agent read. A chat draft is linted with no sources, so a post copied from a library row
 * or a page and labelled `origin=original` went out unchecked (the executor path has the critic gate for this; the chat has
 * none). The turn recorder writes the texts the read tools returned here, per chat and in memory, and the drafts service
 * lints a draft of that chat against them (`origin_mismatch`).
 *
 * Only `{ url, text }` is kept: no image, no publication date, so `image_not_from_source` and the freshness checks stay
 * off for chat drafts. The store is a cache, not a record: a restart empties it, a source falls out after `TTL`.
 */
export const CHAT_READS_TTL_MS = 6 * 3_600_000;
export const CHAT_READS_MAX_CHATS = 100;
export const CHAT_READS_MAX_SOURCES = 40;
/** One source's text (a page the run read is kept up to the same size by the critic gate). */
export const CHAT_READS_SOURCE_CHARS = 60_000;

/** The read tools whose results are kept. */
export const CAPTURED_TOOLS: ReadonlySet<string> = new Set(['web_fetch', 'fetch_feed', 'read_doc', 'find_in_doc', 'query_data', 'search_library']);

interface ChatEntry { touched: number; sources: Map<string, AuditSource> }

export class ChatReadCapture {
  private readonly chats = new Map<string, ChatEntry>();

  constructor(private readonly o: { now?: () => number; ttlMs?: number; maxChats?: number; maxSources?: number } = {}) {}

  private now(): number { return (this.o.now ?? Date.now)(); }

  /** Keep a text the chat's agent read. The same URL again replaces the earlier text. */
  add(chatId: string | null | undefined, source: { url: string; text: string }): void {
    if (!chatId || !source.url || !source.text.trim()) return;
    const now = this.now();
    this.sweep(now);
    let e = this.chats.get(chatId);
    if (!e) {
      e = { touched: now, sources: new Map() };
      this.chats.set(chatId, e);
      const max = this.o.maxChats ?? CHAT_READS_MAX_CHATS;
      while (this.chats.size > max) {
        const oldest = [...this.chats.entries()].sort((a, b) => a[1].touched - b[1].touched)[0];
        if (!oldest || oldest[0] === chatId) break;
        this.chats.delete(oldest[0]);
      }
    }
    e.touched = now;
    // Re-adding moves the source to the end, so the oldest read is the one that falls out.
    e.sources.delete(source.url);
    e.sources.set(source.url, { url: source.url, text: source.text.slice(0, CHAT_READS_SOURCE_CHARS) });
    const cap = this.o.maxSources ?? CHAT_READS_MAX_SOURCES;
    while (e.sources.size > cap) e.sources.delete(e.sources.keys().next().value as string);
  }

  /** What the chat has read in the last `ttl`, newest first. Empty for an unknown chat or a chat without an id. */
  sourcesFor(chatId: string | null | undefined): AuditSource[] {
    if (!chatId) return [];
    this.sweep(this.now());
    const e = this.chats.get(chatId);
    return e ? [...e.sources.values()].reverse() : [];
  }

  /** How many chats the store holds (tests, the cap). */
  size(): number { return this.chats.size; }

  private sweep(now: number): void {
    const ttl = this.o.ttlMs ?? CHAT_READS_TTL_MS;
    for (const [id, e] of this.chats) if (now - e.touched > ttl) this.chats.delete(id);
  }
}

/** The one capture of the process: the turn recorder writes it, the drafts service reads it. */
export const CHAT_READS = new ChatReadCapture();

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const strings = (o: unknown): string[] => (o && typeof o === 'object' ? Object.values(o as Record<string, unknown>).map(str).filter((x): x is string => !!x) : []);

/**
 * The texts a read tool's result holds, as `{ url, text }` (url = the page, the document page or the row's ref). Best
 * effort: an unknown shape gives nothing. Library rows give every text field (a prompt may sit in any of them).
 */
export function readsOf(tool: string, input: unknown, out: unknown): Array<{ url: string; text: string }> {
  const o = (out && typeof out === 'object' ? out : {}) as Record<string, any>;
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const items: Array<{ url: string; text: string }> = [];
  if (tool === 'web_fetch') {
    const text = [o.title, o.description, o.text].map(str).filter(Boolean).join('\n');
    const url = str(o.url) ?? str(i.url);
    if (url && text) items.push({ url, text });
  } else if (tool === 'fetch_feed') {
    for (const it of Array.isArray(o.items) ? o.items : []) {
      const text = [it?.title, it?.snippet].map(str).filter(Boolean).join(' ');
      const url = str(it?.link);
      if (url && text) items.push({ url, text });
    }
  } else if (tool === 'read_doc') {
    const text = str(o.text);
    if (text && str(o.doc_id)) items.push({ url: `doc:${o.doc_id}@${Number(o.from) || 0}`, text });
  } else if (tool === 'find_in_doc') {
    for (const m of Array.isArray(o.matches) ? o.matches : []) {
      const text = str(m?.snippet);
      if (text && str(o.doc_id)) items.push({ url: `doc:${o.doc_id}@${Number(m?.offset) || 0}`, text });
    }
  } else if (tool === 'query_data') {
    for (const row of Array.isArray(o.rows) ? o.rows : []) {
      const text = Object.entries(row ?? {}).filter(([k]) => k !== 'ref').flatMap(([, v]) => (typeof v === 'string' ? [v] : strings(v))).filter((x) => x.trim()).join('\n');
      const url = str(row?.ref) ?? str(row?.url);
      if (url && text) items.push({ url, text });
    }
  } else if (tool === 'search_library') {
    for (const it of Array.isArray(o.items) ? o.items : []) {
      const text = [it?.title, it?.text, ...strings(it?.extra)].map(str).filter(Boolean).join('\n');
      const url = str(it?.library_ref) ?? str(it?.url);
      if (url && text) items.push({ url, text });
    }
  }
  return items;
}
