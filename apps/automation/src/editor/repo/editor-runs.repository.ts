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

  /**
   * Spec 034 FR-012: the typical cost of one slot Preview per channel — the mean of the channel's last `limit`
   * finished executor runs plus the mean of its last critic (`checker`) runs. A channel without executor history
   * is left out (the dashboard then says "one executor run").
   */
  async previewEstimates(channelKeys: string[], limit = 20): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!channelKeys.length) return out;
    const { rows } = await this.pool.query(
      `SELECT channel_key, role, AVG(cost_usd)::float8 AS usd FROM (
         SELECT channel_key, role, cost_usd, ROW_NUMBER() OVER (PARTITION BY channel_key, role ORDER BY started_at DESC) AS rn
           FROM editor_runs
          WHERE channel_key = ANY($1::text[]) AND role IN ('executor', 'checker') AND status = 'ok' AND finished_at IS NOT NULL
       ) x WHERE rn <= $2 GROUP BY 1, 2`, [channelKeys, limit]);
    for (const k of channelKeys) {
      const exec = rows.find((r) => r.channel_key === k && r.role === 'executor');
      if (!exec) continue;
      const checker = rows.find((r) => r.channel_key === k && r.role === 'checker');
      out.set(k, Number((Number(exec.usd) + Number(checker?.usd ?? 0)).toFixed(6)));
    }
    return out;
  }

  /** USD of editor_runs.cost_usd per Kyiv calendar day and channel, for the last `days` days (today included). */
  /**
   * Editor spend per Kyiv day and channel from the llm_usage ledger (spec 029:
   * `feature LIKE 'editor.%'`, LLM calls and paid tool steps). `runs` counts the
   * runs with ledger rows that day. Days older than the raw retention come from
   * the llm_usage_daily rollup (channel from resource_ref, runs 0). Same shape
   * as before for the MCP tool.
   */
  async spendByDay(days: number): Promise<SpendRow[]> {
    const { rows } = await this.pool.query(
      `WITH b AS (
         SELECT ((now() AT TIME ZONE 'Europe/Kyiv')::date - ($1::int - 1)) AS from_day,
                (SELECT (MIN(at) AT TIME ZONE 'Europe/Kyiv')::date FROM llm_usage) AS raw_from
       )
       SELECT (u.at AT TIME ZONE 'Europe/Kyiv')::date::text AS day,
              COALESCE(r.channel_key, CASE WHEN u.resource_ref LIKE 'telegram:%' THEN substr(u.resource_ref, 10) END) AS channel_key,
              COALESCE(SUM(u.cost_usd), 0)::float8 AS usd, COUNT(DISTINCT u.run_id)::int AS runs
         FROM llm_usage u
         LEFT JOIN editor_runs r ON r.id = u.run_id, b
        WHERE u.feature LIKE 'editor.%' AND u.at >= (b.from_day::timestamp AT TIME ZONE 'Europe/Kyiv')
        GROUP BY 1, 2
       UNION ALL
       SELECT d.day::text, CASE WHEN d.resource_ref LIKE 'telegram:%' THEN substr(d.resource_ref, 10) END,
              SUM(d.cost_usd)::float8, 0
         FROM llm_usage_daily d, b
        WHERE d.feature LIKE 'editor.%' AND d.day >= b.from_day AND (b.raw_from IS NULL OR d.day < b.raw_from)
        GROUP BY 1, 2
        ORDER BY 1, 2 NULLS FIRST`,
      [days]);
    return rows.map((r) => ({ day: r.day, channelKey: r.channel_key ?? null, usd: Number(r.usd), runs: Number(r.runs) }));
  }
}
