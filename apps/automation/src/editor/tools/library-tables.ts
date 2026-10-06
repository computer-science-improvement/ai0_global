/**
 * `search_library` (kept for one release as a wrapper over the data store query, spec 032 FR-010) still
 * takes one of the 12 legacy dataset keys and answers in its old shape: title / text / image / url /
 * category from the dataset roles, plus `extra` with a few dataset-specific fields. Prefer
 * `library_catalog` + `query_data`: they read any dataset and return only the fields asked for.
 */

/** Extra fields per legacy dataset: a field name, or a list of fields where the first non-empty wins. */
const BASE_EXTRA: Record<string, Record<string, string | string[]>> = {
  recipes:       { kcal: 'kcal', ingredients: ['ingredients_uk', 'ingredients'], instructions: ['instructions_uk', 'instructions'], telegraph_url: 'telegraph_url' },
  facts:         {},
  quotes:        {},
  prompts:       { media_type: 'media_type', provider: 'provider' },
  on_this_day:   { month: 'month', day: 'day' },
  articles:      {},
  pdr_questions: { ticket_number: 'ticket_number', question_num: 'question_num', answers: 'answers', correct_answer_num: 'correct_answer_num', explanation: 'explanation' },
  birthdays:     { year: 'year', month: 'month', day: 'day' },
  assets:        {},
  tg_posts:      {},
  jokes:         {},
  name_days:     { month: 'month', day: 'day' },
};

/**
 * Provenance (migration 043) merged into every item's `extra`, so the executor can apply the
 * source-licensing skill: write original text and attribute `source_name` when `license` is 'unknown'.
 */
export const PROVENANCE_EXTRA: Record<string, string> = { license: 'license', source_name: 'source_name' };

export const LIBRARY_EXTRA: Record<string, Record<string, string | string[]>> = Object.fromEntries(
  Object.entries(BASE_EXTRA).map(([name, e]) => [name, { ...e, ...PROVENANCE_EXTRA }]),
);

export const LIBRARY_TABLE_NAMES = Object.keys(BASE_EXTRA) as [string, ...string[]];

/** Long extra texts are cut like the old SQL did (instructions ≤ 1500 characters). */
export const EXTRA_MAX_CHARS = 1500;

/** The published_posts.source_url marker for a legacy library row (alias of its data:// ref). */
export function libraryRef(table: string, id: string | number): string {
  return `library://${table}/${id}`;
}
