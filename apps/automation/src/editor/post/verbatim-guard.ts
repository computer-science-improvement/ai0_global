import type { Pool } from 'pg';
import type { PostSpec } from './post-spec';
import { inlineToPlain } from './inline-markup';
import { parseDataRef } from '../../data/data-refs';

/**
 * Library tables whose rows are third-party text that must be retold, not copied
 * (quotes, prompts and PDR questions are intentionally verbatim and excluded).
 * Live evals caught a 126-char verbatim run from a recipe — a copyright risk the
 * source-licensing skill alone did not prevent, so this is a hard publish guard.
 */
const RETELL_SOURCES: Record<string, Array<string | string[]>> = {
  recipes:  ['description', ['instructions_uk', 'instructions']],
  facts:    ['content'],
  articles: ['excerpt', 'content'],
  tg_posts: ['post'],
};

/** The retold source text of a row: the listed fields joined (a list = the first non-empty one). */
export function retellSource(key: string, data: Record<string, unknown>): string {
  const parts = (RETELL_SOURCES[key] ?? []).map((src) => {
    for (const f of Array.isArray(src) ? src : [src]) {
      const v = data[f];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return null;
  });
  return parts.filter(Boolean).join(' ');
}

export const MAX_VERBATIM_RUN = 80;

function squash(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Longest common substring length (chars), O(n·m) with a rolling row — inputs are capped. */
export function longestCommonRun(a: string, b: string): number {
  const x = squash(a).slice(0, 4000);
  const y = squash(b).slice(0, 8000);
  let best = 0;
  const prev = new Uint16Array(y.length + 1);
  for (let i = 1; i <= x.length; i++) {
    let diag = 0;
    for (let j = 1; j <= y.length; j++) {
      const tmp = prev[j];
      prev[j] = x[i - 1] === y[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diag = tmp;
    }
  }
  return best;
}

export function postPlainText(spec: PostSpec): string {
  return spec.body.map((b) => (b.type === 'list' ? b.items.join('\n') : b.text)).map(inlineToPlain).join('\n');
}

export async function checkVerbatim(pool: Pick<Pool, 'query'>, spec: PostSpec): Promise<{ error: string; details: string } | null> {
  // Spec 032: rows live in the data store; the ref is data://<dataset>/<id> or a legacy library:// alias.
  const lib = spec.library_ref?.match(/^library:\/\/([a-z_]+)\/(.+)$/);
  const data = parseDataRef(spec.library_ref);
  const key = lib?.[1] ?? data?.schemaKey;
  if (!key || !RETELL_SOURCES[key]) return null;
  const { rows } = await pool.query(
    `SELECT s.key, d.data FROM data_items d JOIN data_schemas s ON s.id = d.schema_id
      WHERE s.key = $1 AND (d.legacy_ref = $2 OR ($3::bigint IS NOT NULL AND d.id = $3::bigint))`,
    [key, lib ? spec.library_ref : null, data?.id ?? null]);
  const src = rows[0] ? retellSource(key, rows[0].data ?? {}) : '';
  if (!src) return null;
  const run = longestCommonRun(postPlainText(spec), src);
  if (run <= MAX_VERBATIM_RUN) return null;
  return { error: 'too_verbatim', details: `${run} символів поспіль скопійовано з джерела (максимум ${MAX_VERBATIM_RUN}). Перекажи своїми словами — коротше і з іншою структурою речень.` };
}
