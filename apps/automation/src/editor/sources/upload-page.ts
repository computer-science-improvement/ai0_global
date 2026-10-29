import { z } from 'zod';
import { SCHEMA_KEY_RE } from '../../data/data.types';
import { docFromBody } from '../docs/doc-fetch';
import { canonicalUrl, type DocStore } from '../docs/doc-store';
import type { FetchFailure } from '../net/host-failures';
import { isFetchFailure } from '../net/host-failures';
import { UPLOAD_BODY_LIMIT, UPLOAD_PAGE_MAX_CHARS } from './upload-limits';

export { UPLOAD_BODY_LIMIT, UPLOAD_PAGE_MAX_CHARS };

/**
 * Spec 076 FR-005: for a site the server cannot reach, the owner saves the page in a browser and uploads it. The page is parsed
 * exactly as a fetch parses it (`docFromBody`) and kept in the shared DocStore under the page's real address, so the doc id,
 * the `list_ref` values and the `url_anchor:` values equal those of a live import and the rows imported earlier still match.
 */
export const UploadPageBody = z.object({
  /** The page's real address; refs and the ledger use it. */
  url:          z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'an http(s) address'),
  /** The saved page or its text. */
  content:      z.string().min(1).max(UPLOAD_PAGE_MAX_CHARS),
  content_type: z.enum(['text/html', 'text/plain', 'text/markdown']).default('text/html'),
  /** Re-sync this list-import dataset from the page (spec 076 A15; the import marks arrive with T6b). */
  dataset:      z.string().regex(SCHEMA_KEY_RE).optional(),
});
export type UploadPageInput = z.infer<typeof UploadPageBody>;

export interface UploadPageDeps {
  docs: DocStore;
}

/** What an upload without `dataset` answers: the doc id the chat's `import_list` takes, as after `web_fetch`. */
export interface UploadedPage {
  doc_id:   string;
  url:      string;
  kind:     string;
  title:    string | null;
  sections: number;
  chars:    number;
}

/**
 * Keeps an uploaded page. A JSON body is refused (`unsupported_content`): JSON APIs are read from their address, spec 066.
 * A page with no text at all is refused too (`empty_page`), so a wrong file is told at once and not at the import.
 */
export async function uploadPage(deps: UploadPageDeps, input: UploadPageInput): Promise<UploadedPage | FetchFailure> {
  const url = canonicalUrl(input.url);
  const doc = docFromBody(
    { url, fetched_url: null, final_url: url },
    { url, contentType: input.content_type, body: input.content },
    url,
  );
  if (isFetchFailure(doc)) return doc;
  if (doc.kind === 'json') {
    return { error: 'unsupported_content', details: 'the page is JSON: a JSON API is read from its address, not uploaded; upload a saved HTML, markdown or text page' };
  }
  if (!doc.text.trim()) return { error: 'empty_page', details: 'the page has no text: check that the saved file is the page itself' };
  const stored = deps.docs.put({ ...doc, origin: 'upload' });
  return { doc_id: stored.id, url: stored.url, kind: stored.kind, title: stored.title, sections: stored.sections.length, chars: stored.text.length };
}
