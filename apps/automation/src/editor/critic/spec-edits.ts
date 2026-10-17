/**
 * Spec 041 FR-002 (T2): exact text replacements on a post spec — the critic's `pass_with_edits` and the lint's
 * euphony fixes — applied by code without a new LLM turn. A replacement touches only what the reader reads (block
 * text, list items, table cells, slides, the poll, the longread, a platform caption / first comment); never URLs,
 * refs, formats or media. Each `from` must occur exactly once across those strings, so an edit can never land in
 * the wrong place.
 */

export interface TextEdit { from: string; to: string }
export interface FailedEdit extends TextEdit { found: number }

export interface EditResult<T> {
  spec: T;
  applied: TextEdit[];
  failed: FailedEdit[];
}

/** Keys whose strings are not reader text (or must never change): left alone by every edit. */
const NOT_TEXT = new Set([
  'url', 'image', 'library_ref', 'format', 'origin', 'placement', 'kind', 'language', 'idea_id', 'credit', 'alt',
  'type', 'level', 'expression', 'key', 'followup_of', 'event_at', 'decision', 'link', 'media', 'source', 'hashtags',
  'buttons', 'cta', 'story', 'title',
]);
/** Containers whose `title` IS reader text (a slide, a details block, a longread, a TikTok/YouTube title is not edited). */
const TITLED = new Set(['slides', 'longread', 'body', 'blocks']);

type Visit = (s: string) => string;

/** `key` is the field the value sits under (an array passes it on to its items). */
function walk(v: unknown, visit: Visit, key: string | null): unknown {
  if (typeof v === 'string') return visit(v);
  if (Array.isArray(v)) return v.map((x) => walk(x, visit, key));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const titled = k === 'title' && key !== null && TITLED.has(key);
      out[k] = NOT_TEXT.has(k) && !titled ? x : walk(x, visit, k);
    }
    return out;
  }
  return v;
}

const count = (s: string, sub: string) => {
  if (!sub) return 0;
  let n = 0;
  for (let i = s.indexOf(sub); i !== -1; i = s.indexOf(sub, i + sub.length)) n++;
  return n;
};

/** How often `from` occurs across the reader text of a spec. */
export function occurrences(spec: unknown, from: string): number {
  let n = 0;
  walk(spec, (s) => { n += count(s, from); return s; }, null);
  return n;
}

/**
 * Applies the edits in order; each one must match exactly once in the spec as edited so far. A failed edit leaves the
 * spec as it was and is reported with how often it matched (0 = not found, > 1 = ambiguous).
 */
export function applySpecEdits<T>(spec: T, edits: readonly TextEdit[]): EditResult<T> {
  let cur: unknown = spec;
  const applied: TextEdit[] = [];
  const failed: FailedEdit[] = [];
  for (const e of edits) {
    if (!e.from || e.from === e.to) continue;
    const found = occurrences(cur, e.from);
    if (found !== 1) { failed.push({ ...e, found }); continue; }
    cur = walk(cur, (s) => (s.includes(e.from) ? s.replace(e.from, () => e.to) : s), null);
    applied.push(e);
  }
  return { spec: cur as T, applied, failed };
}

/** The exact fixes lint offers (euphony), as edits. */
export function lintFixes(warnings: ReadonlyArray<{ fix?: TextEdit }>): TextEdit[] {
  return warnings.flatMap((w) => (w.fix ? [w.fix] : []));
}
