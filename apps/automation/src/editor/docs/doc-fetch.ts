import { safeGet, type RawGet } from '../net/safe-http';
import type { Lookup } from '../net/ssrf-guard';
import { extractPageFull } from '../net/extract-page';
import { fetchPageGuarded, isFetchFailure, type FetchFailure, type HostFailures } from '../net/host-failures';
import type { CardSource } from '../card';
import type { DocStore, NewDoc } from './doc-store';
import type { StoredDoc } from './doc-types';
import { firstChunk, LARGE_DOC_CHARS, outlineOf } from './doc-view';

/**
 * Spec 065 FR-001: web_fetch's body. The page is fetched once, kept whole in the DocStore, and answered either as
 * before (a short page: title, text, images) or, when it is large, as an outline plus a first chunk and a doc_id to
 * read the rest with.
 */
export interface FetchDocDeps {
  docs:     DocStore;
  http?:    { lookup?: Lookup; get?: RawGet };
  hosts?:   HostFailures;
  sources?: CardSource[];
}

export interface FetchedDoc { doc: StoredDoc; cached: boolean }

export async function fetchDocument(url: string, d: FetchDocDeps): Promise<FetchedDoc | FetchFailure> {
  const hit = d.docs.getByUrl(url);
  if (hit) return { doc: hit, cached: true };
  const res = await fetchPageGuarded(url, d.hosts, d.sources, () => safeGet(url, { lookup: d.http?.lookup, get: d.http?.get }));
  if (isFetchFailure(res)) return res;
  if (!/html|xml|text/i.test(res.contentType) && res.contentType) return { error: 'unsupported_content', details: res.contentType };
  const x = extractPageFull(res.body, res.url);
  const doc: NewDoc = {
    url, fetched_url: null, final_url: res.url, kind: 'html',
    title: x.page.title, description: x.page.description, image: x.page.image, images: x.page.images, published_at: x.page.published_at,
    ...(x.page.primary_links ? { primary_links: x.page.primary_links } : {}),
    text: x.fullText, sections: x.sections,
  };
  return { doc: d.docs.put(doc), cached: false };
}

/** The hint a large document's answer ends with (Ukrainian, like the rest of the agent-facing text). */
const LARGE_HINT = 'Це лише початок великого документа. Решта — read_doc(doc_id, section|from) або find_in_doc(doc_id, query); id секцій s1, s2… йдуть підряд, `next_from` веде далі.';

/** Is the document read through an outline? */
export const isLargeDoc = (doc: StoredDoc): boolean =>
  doc.text.length > LARGE_DOC_CHARS || (doc.kind === 'markdown' && doc.sections.length > 1);

/** What web_fetch answers for a stored document. A short page keeps the shape it always had. */
export function webFetchAnswer(doc: StoredDoc, cached: boolean): Record<string, unknown> {
  const cachedFlag = cached ? { cached: true } : {};
  if (!isLargeDoc(doc)) {
    return {
      url: doc.kind === 'html' ? doc.final_url : doc.url, ...(doc.fetched_url ? { fetched_url: doc.fetched_url } : {}),
      title: doc.title, description: doc.description, image: doc.image, images: doc.images, text: doc.text, published_at: doc.published_at,
      ...(doc.primary_links ? { primary_links: doc.primary_links } : {}), ...cachedFlag,
    };
  }
  const { outline, more } = outlineOf(doc);
  const chunk = firstChunk(doc);
  return {
    url: doc.kind === 'html' ? doc.final_url : doc.url, ...(doc.fetched_url ? { fetched_url: doc.fetched_url } : {}),
    title: doc.title, description: doc.description, image: doc.image,
    ...(doc.kind === 'html' ? { images: doc.images } : {}),
    published_at: doc.published_at, ...(doc.primary_links ? { primary_links: doc.primary_links } : {}),
    doc_id: doc.id, size_chars: doc.text.length, sections: doc.sections.length,
    outline, ...(more ? { outline_more: more } : {}),
    text: chunk.text, next_from: chunk.next_from, hint: LARGE_HINT, ...cachedFlag,
  };
}
