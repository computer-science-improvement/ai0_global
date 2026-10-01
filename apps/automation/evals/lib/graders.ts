import type { Pool } from 'pg';
import type { PostSpec } from '../../src/editor/post/post-spec';
import { inlineToPlain } from '../../src/editor/post/inline-markup';
import { GLOBAL_BANNED } from '../../src/editor/post/lint-post';

export interface Check {
  name:     string;
  pass:     boolean;
  detail?:  string;
  /** soft checks are reported but don't fail the case */
  soft?:    boolean;
}

export const check = (name: string, pass: boolean, detail?: string, soft = false): Check => ({ name, pass, detail, soft });

export function specText(spec: PostSpec): string {
  const blocks = spec.body.map((b) => (b.type === 'list' ? b.items.join('\n') : b.text)).map(inlineToPlain);
  return [spec.title, ...blocks, spec.poll?.question ?? '', ...(spec.poll?.options ?? []), spec.poll?.explanation ?? ''].join('\n');
}

export function isUkrainian(text: string): boolean {
  const letters = text.replace(/https?:\/\/\S+/g, '').match(/\p{L}/gu) ?? [];
  if (letters.length < 20) return true;
  return letters.filter((c) => /[Ѐ-ӿ]/.test(c)).length / letters.length >= 0.7;
}

export function bannedHits(text: string): string[] {
  const low = text.toLowerCase();
  return GLOBAL_BANNED.filter((t) => low.includes(t));
}

/** Every multi-digit number (years, counts, distances) in the post must appear in the source material. */
export function ungroundedNumbers(post: string, source: string): string[] {
  const norm = (s: string) => s.replace(/(\d)[\s ,.](?=\d{3}\b)/g, '$1');
  const nums = (s: string) => new Set((norm(s).match(/\d{2,}/g) ?? []));
  const src = nums(source);
  return [...nums(post)].filter((n) => !src.has(n));
}

/** Longest common substring length (chars) — verbatim copying detector. */
export function longestCommonRun(a: string, b: string): number {
  const x = a.toLowerCase().replace(/\s+/g, ' ');
  const y = b.toLowerCase().replace(/\s+/g, ' ');
  let best = 0;
  const prev = new Array(y.length + 1).fill(0);
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

export async function stepsOf(pool: Pool, runId: string | null): Promise<Array<{ type: string; tool_name: string | null; is_error: boolean; output: any }>> {
  if (!runId) return [];
  const { rows } = await pool.query(
    `SELECT type, tool_name, is_error, output FROM editor_run_steps WHERE run_id = $1 ORDER BY idx`, [runId]);
  return rows;
}

export async function runCost(pool: Pool, runId: string | null): Promise<{ costUsd: number; steps: number; promptTokens: number; completionTokens: number; status: string }> {
  if (!runId) return { costUsd: 0, steps: 0, promptTokens: 0, completionTokens: 0, status: 'none' };
  const { rows } = await pool.query(`SELECT cost_usd, steps, prompt_tokens, completion_tokens, status FROM editor_runs WHERE id = $1`, [runId]);
  const r = rows[0] ?? {};
  return { costUsd: Number(r.cost_usd ?? 0), steps: Number(r.steps ?? 0), promptTokens: Number(r.prompt_tokens ?? 0), completionTokens: Number(r.completion_tokens ?? 0), status: r.status ?? '?' };
}

/** Guard rejections the agent hit (tool outputs with an error field), e.g. lint_failed, too_similar. */
export function toolErrors(steps: Array<{ type: string; tool_name: string | null; output: any }>): string[] {
  return steps.filter((s) => s.type === 'tool' && s.output && typeof s.output.error === 'string')
    .map((s) => `${s.tool_name}:${s.output.error}`);
}
