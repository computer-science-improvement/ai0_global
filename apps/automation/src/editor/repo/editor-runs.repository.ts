import type { Pool } from 'pg';
import type { RunStatus } from '../harness/run-recorder';

export interface EditorRunRow {
  id:               string;
  role:             string;
  channelKey:       string | null;
  slotId:           string | null;
  model:            string;
  status:           RunStatus;
  steps:            number;
  promptTokens:     number;
  completionTokens: number;
  costUsd:          number;
  error:            string | null;
  startedAt:        Date;
  finishedAt:       Date | null;
}

export interface EditorRunStep {
  id:               number;
  idx:              number;
  type:             'llm' | 'tool';
  toolName:         string | null;
  input:            unknown;
  output:           unknown;
  isError:          boolean;
  promptTokens:     number | null;
  completionTokens: number | null;
  costUsd:          number | null;
  durationMs:       number | null;
  createdAt:        Date;
}

export interface SpendRow {
  day:        string;          // Kyiv calendar day, YYYY-MM-DD
  channelKey: string | null;   // null = runs without a channel
  usd:        number;
  runs:       number;
}

const num = (v: unknown) => (v == null ? null : Number(v));

function rowToRun(r: any): EditorRunRow {
  return {
    id: r.id, role: r.role, channelKey: r.channel_key ?? null, slotId: r.slot_id ?? null, model: r.model,
    status: r.status, steps: Number(r.steps), promptTokens: Number(r.prompt_tokens),
    completionTokens: Number(r.completion_tokens), costUsd: Number(r.cost_usd), error: r.error ?? null,
    startedAt: r.started_at, finishedAt: r.finished_at ?? null,
  };
}

/** Read side of editor_runs / editor_run_steps for the ops surface (006). */
export class EditorRunsRepository {
  constructor(private readonly pool: Pool) {}

  async list(f: { channelKey?: string | null; slotId?: string | null; limit: number }): Promise<EditorRunRow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM editor_runs
        WHERE ($1::text IS NULL OR channel_key = $1) AND ($2::uuid IS NULL OR slot_id = $2)
        ORDER BY started_at DESC LIMIT $3`,
      [f.channelKey ?? null, f.slotId ?? null, f.limit]);
    return rows.map(rowToRun);
  }

  async get(id: string): Promise<{ run: EditorRunRow; steps: EditorRunStep[] } | null> {
    const { rows } = await this.pool.query(`SELECT * FROM editor_runs WHERE id = $1`, [id]);
    if (!rows[0]) return null;
    const { rows: steps } = await this.pool.query(
      `SELECT * FROM editor_run_steps WHERE run_id = $1 ORDER BY idx, id`, [id]);
    return {
      run: rowToRun(rows[0]),
      steps: steps.map((s) => ({
        id: Number(s.id), idx: Number(s.idx), type: s.type, toolName: s.tool_name ?? null,
        input: s.input, output: s.output, isError: !!s.is_error,
        promptTokens: num(s.prompt_tokens), completionTokens: num(s.completion_tokens),
        costUsd: num(s.cost_usd), durationMs: num(s.duration_ms), createdAt: s.created_at,
      })),
    };
  }

  /** USD of editor_runs.cost_usd per Kyiv calendar day and channel, for the last `days` days (today included). */
  async spendByDay(days: number): Promise<SpendRow[]> {
    const { rows } = await this.pool.query(
      `SELECT (started_at AT TIME ZONE 'Europe/Kyiv')::date::text AS day, channel_key,
              SUM(cost_usd)::float8 AS usd, COUNT(*)::int AS runs
         FROM editor_runs
        WHERE (started_at AT TIME ZONE 'Europe/Kyiv')::date > (now() AT TIME ZONE 'Europe/Kyiv')::date - $1::int
        GROUP BY 1, 2
        ORDER BY 1, 2 NULLS FIRST`,
      [days]);
    return rows.map((r) => ({ day: r.day, channelKey: r.channel_key ?? null, usd: Number(r.usd), runs: Number(r.runs) }));
  }
}
