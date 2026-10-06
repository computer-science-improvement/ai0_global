import type { Pool } from 'pg';
import type { EditorRole, LlmResponse, ToolCall } from '../llm/llm.types';
import { truncateJson } from './truncate';
import { llmUsage, type LlmUsageRecorder } from '../../common/ai/usage/llm-usage.service';
import { currentLlmContext } from '../../common/ai/usage/llm-context';
import { editorFeature, telegramResource } from '../../common/ai/usage/features';

export type RunStatus = 'running' | 'ok' | 'error' | 'budget_exceeded' | 'max_steps' | 'disabled';

export interface RunStart {
  role:       EditorRole;
  channelKey: string | null;
  slotId?:    string | null;
  model:      string;
  /** The registry agent this run belongs to (spec 017). */
  agentId?:   string | null;
}

export interface RunTotals {
  steps:            number;
  promptTokens:     number;
  completionTokens: number;
  costUsd:          number;
}

export interface RunRecorder {
  start(r: RunStart): Promise<string>;
  llmStep(runId: string, idx: number, res: LlmResponse, durationMs: number): Promise<void>;
  toolStep(runId: string, idx: number, call: ToolCall, input: unknown, output: unknown, isError: boolean, durationMs: number, costUsd?: number | null): Promise<void>;
  finish(runId: string, status: RunStatus, totals: RunTotals, error?: string | null): Promise<void>;
}

/**
 * Persists runs into editor_runs / editor_run_steps. Step writes are
 * best-effort: a failing trace insert must never kill an otherwise-good run,
 * so errors are swallowed after logging by the caller-provided `onError`.
 */
export class PgRunRecorder implements RunRecorder {
  /** Attribution of runs in flight, for the paid-tool ledger rows. */
  private readonly runs = new Map<string, RunStart>();

  constructor(
    private readonly pool: Pool,
    private readonly onError: (msg: string) => void = () => {},
    /** Spend ledger (spec 029); defaults to the process-wide recorder. LLM rows come from the LLM client. */
    private readonly usage?: LlmUsageRecorder,
  ) {}

  async start(r: RunStart): Promise<string> {
    const { rows } = await this.pool.query(
      `INSERT INTO editor_runs (role, channel_key, slot_id, model, agent_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [r.role, r.channelKey, r.slotId ?? null, r.model, r.agentId ?? null],
    );
    this.runs.set(rows[0].id, r);
    return rows[0].id;
  }

  async llmStep(runId: string, idx: number, res: LlmResponse, durationMs: number): Promise<void> {
    await this.insertStep(runId, idx, 'llm', null, null, res.message, false,
      res.usage.promptTokens, res.usage.completionTokens, res.usage.costUsd, durationMs);
  }

  async toolStep(runId: string, idx: number, call: ToolCall, input: unknown, output: unknown, isError: boolean, durationMs: number, costUsd?: number | null): Promise<void> {
    await this.insertStep(runId, idx, 'tool', call.name, input, output, isError, null, null, costUsd ?? null, durationMs);
    if (costUsd) {
      // Paid tools (BR-EDT-26) are ledger rows of the run's feature, so editor spend stays equal to editor_runs.cost_usd.
      const run = this.runs.get(runId);
      const ctx = currentLlmContext();
      (this.usage ?? llmUsage()).record({
        provider: 'tool', kind: 'tool', model: call.name, costUsd, costSource: 'provider',
        runId, stepIdx: idx, status: isError ? 'error' : 'ok', latencyMs: durationMs,
        // The AgentLoop's context carries the full attribution; the run's own fields fill in without one.
        ...(run ? {
          feature: editorFeature(run.role), role: run.role,
          agentId: ctx.agentId ?? run.agentId ?? null,
          resourceRef: ctx.resourceRef ?? (run.channelKey ? telegramResource(run.channelKey) : null),
        } : {}),
      });
    }
  }

  async finish(runId: string, status: RunStatus, t: RunTotals, error?: string | null): Promise<void> {
    this.runs.delete(runId);
    await this.pool.query(
      `UPDATE editor_runs
          SET status = $2, steps = $3, prompt_tokens = $4, completion_tokens = $5,
              cost_usd = $6, error = $7, finished_at = now()
        WHERE id = $1`,
      [runId, status, t.steps, t.promptTokens, t.completionTokens, t.costUsd, error ?? null],
    );
  }

  private async insertStep(
    runId: string, idx: number, type: 'llm' | 'tool', toolName: string | null,
    input: unknown, output: unknown, isError: boolean,
    promptTokens: number | null, completionTokens: number | null, costUsd: number | null, durationMs: number,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO editor_run_steps
           (run_id, idx, type, tool_name, input, output, is_error, prompt_tokens, completion_tokens, cost_usd, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [runId, idx, type, toolName,
          JSON.stringify(truncateJson(input)), JSON.stringify(truncateJson(output)), isError,
          promptTokens, completionTokens, costUsd, durationMs],
      );
    } catch (err: any) {
      this.onError(`editor trace insert failed (run ${runId} step ${idx}): ${err.message}`);
    }
  }
}
