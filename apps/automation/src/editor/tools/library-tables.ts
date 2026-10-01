/**
 * How each content table maps onto the generic "library item" shape the
 * agent sees. Column expressions are code-owned constants — the agent only
 * picks a table name from this enum, never writes SQL here.
 */
export interface LibraryTable {
  title:    string;
  text:     string;
  image?:   string;
  url?:     string;
  category?: string;
  extra?:   string;      // SQL producing a jsonb with table-specific fields
  /** Expression for "is this row about today's date" (month/day tables). */
  today?:   string;
}

export const LIBRARY_TABLES: Record<string, LibraryTable> = {
  recipes: {
    title: `COALESCE(title_uk, title)`,
    text: `CONCAT_WS(E'\\n', description::text, COALESCE(ingredients_uk::text, ingredients::text))`,
    image: 'image_url', url: 'url', category: 'category',
    extra: `jsonb_build_object('kcal', kcal, 'instructions', LEFT(COALESCE(instructions_uk::text, instructions::text), 1500), 'telegraph_url', telegraph_url)`,
  },
  facts:    { title: 'article_title', text: 'content', image: 'image_url', url: 'article_url', category: 'category' },
  quotes:   { title: 'author', text: 'text', url: 'url', category: 'category' },
  prompts:  { title: 'title', text: 'prompt_text', image: 'media_url', url: 'page_url', category: 'category',
              extra: `jsonb_build_object('media_type', media_type, 'provider', provider)` },
  on_this_day: { title: 'title', text: `COALESCE(description, excerpt)`, image: 'image_url',
                 extra: `jsonb_build_object('month', month, 'day', day)`, today: 'month = $M AND day = $D' },
  articles: { title: 'title', text: `COALESCE(excerpt, LEFT(content, 2000))`, image: 'image_url', url: 'url', category: 'category' },
  pdr_questions: {
    title: `CONCAT('Білет ', ticket_number, ', питання ', question_num)`, text: 'text', image: 'image_url',
    extra: `jsonb_build_object('answers', answers, 'correct_answer_num', correct_answer_num, 'explanation', explanation)`,
  },
  birthdays: { title: 'name', text: `CONCAT('Народився(лась) ', day, '.', month, '.', year)`,
               extra: `jsonb_build_object('year', year, 'month', month, 'day', day)`, today: 'month = $M AND day = $D' },
  assets:   { title: 'title', text: 'description', url: `COALESCE(link, source_url)`, category: 'category' },
  tg_posts: { title: 'title', text: 'post', image: 'image_url', url: 'source_url' },
  jokes:    { title: 'title', text: 'content', url: 'url' },
  name_days: { title: 'name', text: `CONCAT('Іменини ', day, '.', month)`, today: 'month = $M AND day = $D' },
};

export const LIBRARY_TABLE_NAMES = Object.keys(LIBRARY_TABLES) as [string, ...string[]];

/** The published_posts.source_url marker for a library row — the single dedup key for library content. */
export function libraryRef(table: string, id: string | number): string {
  return `library://${table}/${id}`;
}
