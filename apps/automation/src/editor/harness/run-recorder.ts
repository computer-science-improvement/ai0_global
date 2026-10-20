import type { Pool } from 'pg';
import type { EditorRole, LlmResponse, ToolCall } from '../llm/llm.types';
import { truncateJson } from './truncate';
import { llmUsage, type LlmUsageRecorder } from '../../common/ai/usage/llm-usage.service';
import { currentLlmContext } from '../../common/ai/usage/llm-context';
import { editorFeature, telegramResource } from '../../common/ai/usage/features';

/** `no_terminal` (spec 040 FR-003): a role that ends with a terminal tool answered without one. */
export type RunStatus = 'running' | 'ok' | 'error' | 'budget_exceeded' | 'max_steps' | 'disabled' | 'no_terminal';

/** The loop's circuit breaker counters (spec 040 FR-002). */
export interface RunBreaker {
  repeatBlocked: number;
  toolsDropped:  string[];
}

export interface RunStart {
  role:       EditorRole;
  channelKey: string | null;
  slotId?:    string | null;
  model:      string;
  /** The registry agent this run belongs to (spec 017). */
  agentId?:   string | null;
  /** Spec 054 FR-002: the tool names offered to the run (fixed for the whole run), written once at the start. */
  toolsOffered?: string[];
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
  finish(runId: string, status: RunStatus, totals: RunTotals, error?: string | null, breaker?: RunBreaker): Promise<void>;
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
      `INSERT INTO editor_runs (role, channel_key, slot_id, model, agent_id, tools_offered) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [r.role, r.channelKey, r.slotId ?? null, r.model, r.agentId ?? null, r.toolsOffered ?? null],
    );
    this.runs.set(rows[0].id, r);
    return rows[0].id;
  }

  async llmStep(runId: string, idx: number, res: LlmResponse, durationMs: number): Promise<void> {
    await this.insertStep(runId, idx, 'llm', null, null, traceMessage(res.message), false,
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
          feature: ctx.feature?.startsWith('editor.') ? ctx.feature : editorFeature(run.role), role: run.role,
          agentId: ctx.agentId ?? run.agentId ?? null,
          resourceRef: ctx.resourceRef ?? (run.channelKey ? telegramResource(run.channelKey) : null),
        } : {}),
      });
    }
  }

  async finish(runId: string, status: RunStatus, t: RunTotals, error?: string | null, breaker?: RunBreaker): Promise<void> {
    this.runs.delete(runId);
    await this.pool.query(
      `UPDATE editor_runs
          SET status = $2, steps = $3, prompt_tokens = $4, completion_tokens = $5,
              cost_usd = $6, error = $7, finished_at = now(),
              repeat_blocked = $8, tools_dropped = $9
        WHERE id = $1`,
      [runId, status, t.steps, t.promptTokens, t.completionTokens, t.costUsd, error ?? null,
        breaker?.repeatBlocked ?? 0, breaker?.toolsDropped.length ? breaker.toolsDropped : null],
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

/**
 * The assistant message as the run trace stores it (spec 038): the provider's raw blocks are dropped (thinking
 * signatures are opaque and large); the thinking text is kept, capped, so the run page shows why the model acted.
 */
export function traceMessage(m: LlmResponse['message']): Record<string, unknown> {
  const { providerContent, ...rest } = m;
  const thinking = Array.isArray(providerContent)
    ? providerContent.filter((b: any) => b?.type === 'thinking' && typeof b.thinking === 'string').map((b: any) => b.thinking).join('\n').trim()
    : '';
  return thinking ? { ...rest, thinking: thinking.slice(0, 4000) } : rest;
}
