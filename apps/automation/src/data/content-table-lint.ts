/**
 * Spec 032 FR-009: no new code may reference a content table by name. Content lives in the data store
 * (`data_items` + `data_schemas`), addressed by schema key; the old table names survive only as
 * compatibility views for the legacy readers listed in the lint test's allow-list.
 */

export const CONTENT_TABLES = [
  'recipes', 'facts', 'quotes', 'prompts', 'on_this_day', 'articles', 'pdr_questions',
  'birthdays', 'assets', 'tg_posts', 'jokes', 'name_days',
] as const;

const NAMES = CONTENT_TABLES.join('|');
// SQL that names a content table as a relation, e.g. `FROM recipes`, `UPDATE public."facts"`, `JOIN quotes q`.
const SQL_REF = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE|TABLE)\\s+(?:public\\.)?"?(${NAMES})"?(?!\\w)`, 'gi');
// The old pipeline helper: loadRows('facts', …).
const LOADER_REF = new RegExp(`\\bloadRows\\(\\s*['"\`](${NAMES})['"\`]`, 'g');

export interface ContentTableRef { line: number; table: string; text: string }

/** References in one source file. Comment-only lines are ignored (prose like "draw from facts"). */
export function findContentTableRefs(source: string): ContentTableRef[] {
  const out: ContentTableRef[] = [];
  source.split('\n').forEach((text, i) => {
    const t = text.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('--')) return;
    for (const re of [SQL_REF, LOADER_REF]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) out.push({ line: i + 1, table: (m[2] ?? m[1]).toLowerCase(), text: t.slice(0, 160) });
    }
  });
  return out;
}
