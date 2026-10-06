import type { Pool } from 'pg';
import type { PostSpec } from './post-spec';
import { parseDataRef } from '../../data/data-refs';

const PDR = 'pdr_questions';

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * A quiz built from a library row that carries its own answer key (pdr_questions)
 * must mark the DB's correct answer as correct. Live evals caught the model
 * "correcting" a PDR answer from its own (wrong) memory — for a driving-rules
 * channel that is unacceptable, so this is a hard publish guard, not a prompt rule.
 * Returns null when the spec is fine or not checkable.
 */
export async function checkQuizGroundTruth(pool: Pick<Pool, 'query'>, spec: PostSpec): Promise<{ error: string; details: string } | null> {
  if (spec.format !== 'quiz' || !spec.poll || !spec.library_ref) return null;
  // Spec 032: the answer key lives in the data store; the ref is data://pdr_questions/<id> or its legacy library:// alias.
  const data = parseDataRef(spec.library_ref);
  const legacy = spec.library_ref.startsWith(`library://${PDR}/`);
  if (!legacy && data?.schemaKey !== PDR) return null;
  const { rows } = await pool.query(
    `SELECT d.data->'answers' AS answers, d.data->>'correct_answer_num' AS correct_answer_num
       FROM data_items d JOIN data_schemas s ON s.id = d.schema_id
      WHERE s.key = $1 AND (d.legacy_ref = $2 OR ($3::bigint IS NOT NULL AND d.id = $3::bigint))`,
    [PDR, legacy ? spec.library_ref : null, data?.id ?? null]);
  const id = spec.library_ref.split('/').pop();
  if (!rows[0]) return { error: 'library_ref_not_found', details: `pdr_questions ${id} does not exist` };
  const answers: string[] = Array.isArray(rows[0].answers) ? rows[0].answers.map((a: any) => String(a?.text ?? a)) : [];
  const truth = answers[Number(rows[0].correct_answer_num) - 1];
  if (!truth) return null;
  const chosen = spec.poll.correct_index !== undefined ? spec.poll.options[spec.poll.correct_index] : undefined;
  if (chosen && norm(chosen) === norm(truth)) return null;
  return {
    error: 'quiz_answer_mismatch',
    details: `правильна відповідь у базі: "${truth}". Познач саме її як correct_index (текст варіанта має збігатися), не виправляй базу власними знаннями.`,
  };
}
