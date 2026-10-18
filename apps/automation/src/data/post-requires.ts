/**
 * What a row needs before it can be posted (migration 083). A dataset's `post_requires` is a list of
 * groups of field names; a row can be posted when every group has at least one filled field.
 *
 *   prompts: [["page_url"], ["prompt_text", "media_url"]]  → a link to the prompt's own page, and its text
 *                                                             or an example image
 *
 * The database has the same rule (`data_postable()`, `data_post_missing()`): new rows that miss a group
 * are invalid, and the catalog, `query_data` and the stats skip existing rows that miss one. This copy
 * serves the import dry run, so the owner sees those rows before committing.
 */

export type PostRequires = Array<string[] | string>;

/** Filled unless missing, null, blank text, [] or {} (as `data_value_present()`). */
export function valuePresent(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

const group = (g: string[] | string): string[] => (Array.isArray(g) ? g : [g]);

/** The groups a row misses, each as "a or b"; empty when the row can be posted. */
export function postMissing(requires: PostRequires | null | undefined, data: Record<string, unknown>): string[] {
  return (requires ?? []).filter((g) => !group(g).some((f) => valuePresent(data[f]))).map((g) => group(g).join(' or '));
}

/** The rule in words, one entry per group ("page_url", "prompt_text or media_url"). */
export function describePostRequires(requires: PostRequires | null | undefined): string[] {
  return (requires ?? []).map((g) => group(g).join(' or '));
}
