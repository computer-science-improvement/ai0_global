import type { Pool } from 'pg';
import type { PostSpec } from './post-spec';
import { parseDataRef } from '../../data/data-refs';

const PDR = 'pdr_questions';
/** Telegram allows 100 characters per poll option; a longer correct answer is cut by the writer. */
const POLL_OPTION_LIMIT = 100;

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
/** Words of an option for the cut-prefix comparison: case, punctuation and apostrophes inside words ignored. */
const words = (s: string) => s.split(/\s+/).map(norm).filter(Boolean);

export interface AnswerOption { num: number; text: string }
export type AnswerKey =
  | { ok: true; truth: AnswerOption; options: AnswerOption[] }
  | { ok: false; details: string };

const hasNum = (a: unknown): a is { num: number; text?: unknown } =>
  !!a && typeof a === 'object' && typeof (a as any).num === 'number' && Number.isFinite((a as any).num);
const textOf = (a: unknown): string => String((a as any)?.text ?? a);

function parseKey(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null;
  if (typeof raw === 'string' && /^\s*-?\d+\s*$/.test(raw)) return Number(raw);
  return null;
}

/**
 * Spec 079 FR-001: the correct option of a pdr_questions row is the one whose `num` equals
 * `correct_answer_num` (the data is {num, text} with num counting from 0). Options without `num`
 * (bare strings, {text}) get their base decided: 0 when the key is 0, 1 when the key is the option
 * count, else 0 when the dataset has a key of 0 anywhere (`zeroBased`), else 1.
 * A key that names no option is an error, never a pass.
 */
export function resolveAnswerKey(
  row: { answers: unknown; correct_answer_num: unknown },
  opts: { zeroBased: boolean; id?: string },
): AnswerKey {
  const id = opts.id ?? 'pdr_questions';
  const fail = (details: string): AnswerKey => ({
    ok: false,
    details: `${id}: ${details}. Ключ відповіді в рядку зламаний: візьми інший рядок або skip_slot з ref цього рядка.`,
  });
  const raw = Array.isArray(row.answers) ? row.answers : [];
  const key = parseKey(row.correct_answer_num);
  const shown = row.correct_answer_num === null || row.correct_answer_num === undefined ? 'немає' : JSON.stringify(row.correct_answer_num);
  if (raw.length === 0) return fail(`correct_answer_num = ${shown}, але варіантів відповіді немає`);

  let options: AnswerOption[];
  if (raw.every(hasNum)) {
    options = raw.map((a: any) => ({ num: a.num, text: textOf(a) }));
  } else {
    const base = key === 0 ? 0 : key === raw.length ? 1 : opts.zeroBased ? 0 : 1;
    options = raw.map((a: any, i: number) => ({ num: i + base, text: textOf(a) }));
  }
  const truth = key === null ? undefined : options.find((o) => o.num === key);
  if (!truth) {
    const have = [...options.map((o) => o.num)].sort((a, b) => a - b).join(', ');
    return fail(`correct_answer_num = ${shown}, варіантів з таким num немає (є num ${have})`);
  }
  return { ok: true, truth, options };
}

/** True when `chosen` (a trailing «…» dropped) is a word-boundary prefix of `full`: the last chosen word is whole. */
function isWordPrefix(chosen: string, full: string): boolean {
  const c = words(chosen.replace(/\s*(…|\.{3})\s*$/u, ''));
  const f = words(full);
  return c.length > 0 && c.length <= f.length && c.every((w, i) => w === f[i]);
}

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
  // Spec 079 FR-001: the dataset-wide "any key is 0" check rides in the same query as the row.
  const { rows } = await pool.query(
    `SELECT d.data->'answers' AS answers, d.data->>'correct_answer_num' AS correct_answer_num,
            EXISTS (SELECT 1 FROM data_items z WHERE z.schema_id = d.schema_id AND z.data->>'correct_answer_num' = '0') AS zero_based
       FROM data_items d JOIN data_schemas s ON s.id = d.schema_id
      WHERE s.key = $1 AND (d.legacy_ref = $2 OR ($3::bigint IS NOT NULL AND d.id = $3::bigint))`,
    [PDR, legacy ? spec.library_ref : null, data?.id ?? null]);
  const id = spec.library_ref.split('/').pop();
  if (!rows[0]) return { error: 'library_ref_not_found', details: `pdr_questions ${id} does not exist` };
  const key = resolveAnswerKey(rows[0], { zeroBased: rows[0].zero_based === true, id });
  if (!key.ok) return { error: 'quiz_answer_key_invalid', details: key.details };
  const { truth, options } = key;
  const chosen = spec.poll.correct_index !== undefined ? spec.poll.options[spec.poll.correct_index] : undefined;
  if (chosen && norm(chosen) === norm(truth.text)) return null;
  let ambiguity = false;
  if (chosen && truth.text.length > POLL_OPTION_LIMIT && isWordPrefix(chosen, truth.text)) {
    ambiguity = options.some((o) => o !== truth && isWordPrefix(chosen, o.text));
    if (!ambiguity) return null;
  }
  const how = `Познач саме його як correct_index; довгий варіант (понад ${POLL_OPTION_LIMIT} символів) обріж по межі слова, можна з «…». Не виправляй базу власними знаннями.`;
  return {
    error: 'quiz_answer_mismatch',
    details: ambiguity
      ? `варіант обрізано так, що він збігається з початком іншої відповіді — обріж довше або інакше. Правильна відповідь у базі — варіант num=${truth.num}: "${truth.text}". ${how}`
      : `правильна відповідь у базі — варіант num=${truth.num}: "${truth.text}". ${how}`,
  };
}
