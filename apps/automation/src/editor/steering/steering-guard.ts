import type { Pool } from 'pg';
import { longestSharedRun } from './common-run';
import { refName } from './steering.repository';
import { POST_COPY_MAX_CHARS, type SourcePost } from './steering.types';

/**
 * Spec 045 FR-006: a post for a resource with active steering sets may not repeat a reference post's text — a shared
 * run of POST_COPY_MAX_CHARS (the library guard's limit) or more is refused at the publish guards.
 */
export async function checkSteeringCopy(
  pool: Pick<Pool, 'query'>, targetRef: string, text: string,
): Promise<{ error: 'steering_copy'; details: string } | null> {
  if (!text.trim()) return null;
  const { rows } = await pool.query(
    `SELECT source_ref, posts FROM steering_sets WHERE target_ref = $1 AND status = 'active'`, [targetRef]);
  const refs: Array<{ source: string; key: string; text: string }> = rows.flatMap((r: any) =>
    ((r.posts ?? []) as SourcePost[]).filter((p) => p.text).map((p) => ({ source: refName(r.source_ref), key: p.key, text: p.text })));
  if (!refs.length) return null;
  const run = longestSharedRun(text, refs.map((r) => r.text));
  if (run.chars < POST_COPY_MAX_CHARS) return null;
  const hit = refs[run.index];
  return {
    error: 'steering_copy',
    details: `${run.chars} символів поспіль повторюють пост ${hit.key} референсу ${hit.source} (максимум ${POST_COPY_MAX_CHARS - 1}). Steering — це напрям, не текст: скажи своїми словами, на тему свого каналу.`,
  };
}
