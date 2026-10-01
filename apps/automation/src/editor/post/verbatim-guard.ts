import type { Pool } from 'pg';
import type { PostSpec } from './post-spec';
import { inlineToPlain } from './inline-markup';

/**
 * Library tables whose rows are third-party text that must be retold, not copied
 * (quotes, prompts and PDR questions are intentionally verbatim and excluded).
 * Live evals caught a 126-char verbatim run from a recipe — a copyright risk the
 * source-licensing skill alone did not prevent, so this is a hard publish guard.
 */
const RETELL_SOURCES: Record<string, string> = {
  recipes:  `CONCAT_WS(' ', description, COALESCE(instructions_uk, instructions))`,
  facts:    `content`,
  articles: `CONCAT_WS(' ', excerpt, content)`,
  tg_posts: `post`,
};

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
  const m = spec.library_ref?.match(/^library:\/\/([a-z_]+)\/(.+)$/);
  if (!m || !RETELL_SOURCES[m[1]]) return null;
  const { rows } = await pool.query(`SELECT ${RETELL_SOURCES[m[1]]} AS src FROM ${m[1]} WHERE id::text = $1`, [m[2]]);
  const src = String(rows[0]?.src ?? '');
  if (!src) return null;
  const run = longestCommonRun(postPlainText(spec), src);
  if (run <= MAX_VERBATIM_RUN) return null;
  return { error: 'too_verbatim', details: `${run} символів поспіль скопійовано з джерела (максимум ${MAX_VERBATIM_RUN}). Перекажи своїми словами — коротше і з іншою структурою речень.` };
}
