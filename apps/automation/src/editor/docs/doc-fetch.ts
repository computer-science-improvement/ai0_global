import { safeGet, type RawGet, type SafeGetResult } from '../net/safe-http';
import type { Lookup } from '../net/ssrf-guard';
import { extractPageFull } from '../net/extract-page';
import { fetchPageGuarded, isFetchFailure, type FetchFailure, type HostFailures } from '../net/host-failures';
import type { CardSource } from '../card';
import type { DocStore, NewDoc } from './doc-store';
import type { StoredDoc } from './doc-types';
import { buildJsonDoc, isJsonContentType, jsonAnswer, parseJsonBody } from './doc-json';
import { firstChunk, LARGE_DOC_CHARS, outlineOf } from './doc-view';
import { githubRawCandidates, isMarkdownPath, isRawGithub } from './github-url';
import { isBadgeImage, parseMarkdown } from './markdown-doc';

/**
 * Spec 065 FR-001 / FR-002: web_fetch's body. The page is fetched once, kept whole in the DocStore, and answered either
 * as before (a short page: title, text, images) or, when it is large, as an outline plus a first chunk and a doc_id to
 * read the rest with. A GitHub repository or file page is fetched as the raw file; markdown is parsed as markdown.
 *
 * Spec 070 FR-003: when the refetch of an address fails because the site is down or turns the request away, the copy the
 * store still keeps is answered instead (`stale`), with the time it was fetched.
 */
export interface FetchDocDeps {
  docs:     DocStore;
  http?:    { lookup?: Lookup; get?: RawGet };
  hosts?:   HostFailures;
  sources?: CardSource[];
  /** Fetch again even when the store holds the page (a re-sync wants the page as it is now). It never falls back to a stale copy. */
  fresh?:   boolean;
  /** Pause before the one retry of a connection reset (default 1000 ms; tests pass 0). */
  retryMs?: number;
}

/** `stale`: the site failed (`reason`) and `doc` is the copy kept from an earlier fetch. */
export interface FetchedDoc { doc: StoredDoc; cached: boolean; stale?: { reason: string } }

/**
 * Why a failed fetch may be answered with the kept copy, or null: the site is blocked or unreachable, answers 5xx, or turns
 * the request away (401 / 403 / 429 / 451). A page that is gone (404 / 410) or is not a document is not served from the past.
 */
function servableFailure(f: FetchFailure): string | null {
  if (f.error === 'host_blocked' || f.error === 'host_unreachable') return f.error;
  if (f.error !== 'http_error') return null;
  const m = /^status (\d{3})/.exec(f.details);
  const status = m ? Number(m[1]) : 0;
  return status >= 500 || [401, 403, 429, 451].includes(status) ? `status ${status}` : null;
}

const isNotFound = (r: unknown): boolean => isFetchFailure(r) && /^status (404|410)/.test(r.details);

/** Pages kept as images for a post: the first ten pictures of a markdown file that are not badges. */
const MD_IMAGES_MAX = 10;

/** Is this response a markdown file? By content type, or a plain-text answer for a `.md` path, or raw GitHub content of one. */
function isMarkdown(res: SafeGetResult, asked: string): boolean {
  if (/markdown/i.test(res.contentType)) return true;
  const plain = !res.contentType || /text\/plain/i.test(res.contentType);
  return plain && (isMarkdownPath(res.url) || isMarkdownPath(asked));
}

export async function fetchDocument(url: string, d: FetchDocDeps): Promise<FetchedDoc | FetchFailure> {
  const hit = d.fresh ? null : d.docs.fresh(url);
  if (hit) return { doc: hit, cached: true };
  const kept = d.fresh ? null : d.docs.keptByUrl(url);
  const r = await fetchLive(url, d);
  if (kept && isFetchFailure(r)) {
    const reason = servableFailure(r);
    if (reason) return { doc: kept, cached: true, stale: { reason } };
  }
  return r;
}

async function fetchLive(url: string, d: FetchDocDeps): Promise<FetchedDoc | FetchFailure> {
  const get = (u: string) => fetchPageGuarded(u, d.hosts, d.sources, () => safeGet(u, { lookup: d.http?.lookup, get: d.http?.get }), d.retryMs);

  // A GitHub repository / file page is its raw file; when no candidate exists the page itself is fetched as before.
  let res: SafeGetResult | FetchFailure | null = null;
  let fetchedUrl: string | null = null;
  for (const raw of githubRawCandidates(url) ?? []) {
    const r = await get(raw);
    if (isNotFound(r)) continue;
    res = r;
    fetchedUrl = raw;
    break;
  }
  if (!res) res = await get(url);
  if (isFetchFailure(res)) return res;
  const jsonType = isJsonContentType(res.contentType);
  if (!jsonType && !/html|xml|text/i.test(res.contentType) && res.contentType) return { error: 'unsupported_content', details: res.contentType };

  const base = { url, fetched_url: fetchedUrl ?? (res.url !== url && isRawGithub(res.url) ? res.url : null), final_url: res.url };
  let doc: NewDoc;
  // Spec 066 FR-001: JSON by its content type, or a plain-text / untyped body that parses as an object or an array.
  const plainBody = !res.contentType || /text\/plain/i.test(res.contentType);
  const json = jsonType || (plainBody && !isMarkdown(res, url)) ? parseJsonBody(res.body) : null;
  if (jsonType && json === null) return { error: 'unsupported_content', details: 'invalid JSON' };
  if (json !== null) {
    const j = buildJsonDoc(json);
    doc = { ...base, kind: 'json', title: null, description: null, image: null, images: [], published_at: null, text: j.text, sections: j.sections, json: j.json };
  } else if (isMarkdown(res, url)) {
    const md = parseMarkdown(res.body, res.url);
    const heading = md.sections.find((s) => s.level === 1) ?? md.sections.find((s) => s.level > 0);
    const pictures = md.sections.flatMap((s) => s.images.map((i) => i.src)).filter((s) => !isBadgeImage(s));
    doc = {
      ...base, kind: 'markdown', title: heading?.heading || null, description: null,
      image: pictures[0] ?? null, images: [...new Set(pictures)].slice(0, MD_IMAGES_MAX), published_at: null,
      text: md.text, sections: md.sections,
    };
  } else if (/html|xml/i.test(res.contentType) || !res.contentType) {
    const x = extractPageFull(res.body, res.url);
    doc = {
      ...base, kind: 'html',
      title: x.page.title, description: x.page.description, image: x.page.image, images: x.page.images, published_at: x.page.published_at,
      ...(x.page.primary_links ? { primary_links: x.page.primary_links } : {}),
      text: x.fullText, sections: x.sections,
    };
  } else {
    // Plain text that is not markdown: kept as it is, newlines included, as one section.
    const text = res.body.replace(/\r\n?/g, '\n');
    doc = {
      ...base, kind: 'text', title: null, description: null, image: null, images: [], published_at: null, text,
      sections: text.trim() ? [{ heading: '', level: 1, start: 0, end: text.length, images: [], links: [], code_blocks: [] }] : [],
    };
  }
  return { doc: d.docs.put(doc), cached: false };
}

/** The hint a large document's answer ends with (Ukrainian, like the rest of the agent-facing text). */
const LARGE_HINT = 'Це лише початок великого документа. Решта — read_doc(doc_id, section|from) або find_in_doc(doc_id, query); id секцій s1, s2… йдуть підряд, `next_from` веде далі.';

/** Is the document read through an outline? */
export const isLargeDoc = (doc: StoredDoc): boolean =>
  doc.text.length > LARGE_DOC_CHARS || (doc.kind === 'markdown' && doc.sections.length > 1);

/** What web_fetch answers for a stored document. A short page keeps the shape it always had. */
export function webFetchAnswer(doc: StoredDoc, cached: boolean, stale?: { reason: string }): Record<string, unknown> {
  const fetchedAt = new Date(doc.fetched_at).toISOString();
  const cachedFlag = {
    ...(cached ? { cached: true } : {}),
    // Spec 070: the site failed and this is the copy from an earlier fetch; say so, with its time.
    ...(stale ? { stale: true, fetched_at: fetchedAt, note: `копія від ${fetchedAt.slice(0, 16).replace('T', ' ')} UTC; сайт зараз недоступний` } : {}),
  };
  const asJson = doc.kind === 'json' ? jsonAnswer(doc, cachedFlag) : null;
  if (asJson) return asJson;
  const where = { url: doc.kind === 'html' ? doc.final_url : doc.url, ...(doc.fetched_url ? { fetched_url: doc.fetched_url } : {}) };
  if (!isLargeDoc(doc)) {
    return {
      ...where, title: doc.title, description: doc.description, image: doc.image, images: doc.images, text: doc.text,
      published_at: doc.published_at, ...(doc.primary_links ? { primary_links: doc.primary_links } : {}), ...cachedFlag,
    };
  }
  const { outline, more } = outlineOf(doc);
  const chunk = firstChunk(doc);
  return {
    ...where, title: doc.title, description: doc.description, image: doc.image,
    // An HTML page lists its images as before; a markdown file's pictures belong to its sections (read_doc shows them there).
    ...(doc.kind === 'html' ? { images: doc.images } : {}),
    published_at: doc.published_at, ...(doc.primary_links ? { primary_links: doc.primary_links } : {}),
    doc_id: doc.id, size_chars: doc.text.length, sections: doc.sections.length,
    outline, ...(more ? { outline_more: more } : {}),
    text: chunk.text, next_from: chunk.next_from, hint: LARGE_HINT, ...cachedFlag,
  };
}

/** Spec 066 FR-003: one more page of a paged JSON API, fetched fresh through the host guard and not kept in the store. */
export async function fetchJsonPage(url: string, d: Pick<FetchDocDeps, 'http' | 'hosts' | 'sources' | 'retryMs'>): Promise<{ url: string; value: unknown } | FetchFailure> {
  const res = await fetchPageGuarded(url, d.hosts, d.sources, () => safeGet(url, { lookup: d.http?.lookup, get: d.http?.get }), d.retryMs);
  if (isFetchFailure(res)) return res;
  const value = parseJsonBody(res.body);
  if (value === null) return { error: 'unsupported_content', details: 'invalid JSON' };
  return { url, value };
}
