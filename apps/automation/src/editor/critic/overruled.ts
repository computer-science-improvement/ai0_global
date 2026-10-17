import type { Pool } from 'pg';

/**
 * Spec 041 FR-006 (T6): lint warnings the critic overruled — codes on posts it passed. A code the critic passes again
 * and again is either a false positive (fix the check) or a blind spot of the critic (fix the rubric); the MANAGER
 * sees the top codes in the KPI digest (`lint_overruled`).
 */
export interface OverruledCode { code: string; posts: number }

export const OVERRULED_DAYS = 7;
export const OVERRULED_TOP = 8;

/** Counts each warning code once per passed post, most frequent first. */
export function overruledWarnings(rows: ReadonlyArray<{ critic: unknown }>, top = OVERRULED_TOP): OverruledCode[] {
  const n = new Map<string, number>();
  for (const r of rows) {
    const c = r.critic as { verdict?: unknown; lint_warnings?: unknown } | null;
    if (!c || c.verdict !== 'pass' || !Array.isArray(c.lint_warnings)) continue;
    for (const code of new Set(c.lint_warnings.filter((x): x is string => typeof x === 'string'))) n.set(code, (n.get(code) ?? 0) + 1);
  }
  return [...n.entries()].map(([code, posts]) => ({ code, posts })).sort((a, b) => b.posts - a.posts || a.code.localeCompare(b.code)).slice(0, top);
}

/** The passed slots of the last `days` days, counted. A failing read is an empty list (the digest goes on). */
export async function overruledWarningsOf(pool: Pick<Pool, 'query'>, days = OVERRULED_DAYS): Promise<OverruledCode[]> {
  try {
    const { rows } = await pool.query(
      `SELECT critic FROM editor_slots
        WHERE critic IS NOT NULL AND critic->>'verdict' = 'pass' AND critic ? 'lint_warnings'
          AND updated_at >= now() - ($1 || ' days')::interval`, [String(days)]);
    return overruledWarnings(rows);
  } catch {
    return [];
  }
}
