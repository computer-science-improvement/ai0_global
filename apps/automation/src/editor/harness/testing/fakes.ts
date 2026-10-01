import type { LlmClient, LlmRequest, LlmResponse, ToolCall } from '../../llm/llm.types';
import type { BudgetGate, BudgetVerdict } from '../budget.service';
import type { RunRecorder, RunStart, RunStatus, RunTotals } from '../run-recorder';

/** Scripted LLM: each chat() returns the next scripted turn. */
export class FakeLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  private i = 0;
  constructor(private readonly turns: Array<{ text?: string | null; calls?: Array<{ name: string; args: unknown; id?: string }>; cost?: number; finish?: string } | Error>) {}

  async chat(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(JSON.parse(JSON.stringify(req)));
    const t = this.turns[this.i++];
    if (!t) throw new Error('FakeLlm: script exhausted');
    if (t instanceof Error) throw t;
    const toolCalls: ToolCall[] | undefined = t.calls?.map((c, k) => ({
      id: c.id ?? `call_${this.i}_${k}`, name: c.name,
      arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args),
    }));
    return {
      message: { role: 'assistant', content: t.text ?? null, ...(toolCalls ? { toolCalls } : {}) },
      finishReason: t.finish ?? (toolCalls ? 'tool_calls' : 'stop'),
      usage: { promptTokens: 100, completionTokens: 10, costUsd: t.cost ?? 0.0001 },
    };
  }
}

export class MemoryRecorder implements RunRecorder {
  runs: Array<RunStart & { id: string; status?: RunStatus; totals?: RunTotals; error?: string | null }> = [];
  steps: Array<{ runId: string; idx: number; type: 'llm' | 'tool'; tool?: string; input?: unknown; output?: unknown; isError?: boolean }> = [];

  async start(r: RunStart): Promise<string> {
    const id = `run-${this.runs.length + 1}`;
    this.runs.push({ ...r, id });
    return id;
  }
  async llmStep(runId: string, idx: number): Promise<void> { this.steps.push({ runId, idx, type: 'llm' }); }
  async toolStep(runId: string, idx: number, call: ToolCall, input: unknown, output: unknown, isError: boolean): Promise<void> {
    this.steps.push({ runId, idx, type: 'tool', tool: call.name, input, output, isError });
  }
  async finish(runId: string, status: RunStatus, totals: RunTotals, error?: string | null): Promise<void> {
    const r = this.runs.find((x) => x.id === runId)!;
    r.status = status; r.totals = { ...totals }; r.error = error;
  }
}

export class FakeBudget implements BudgetGate {
  constructor(private readonly verdicts: BudgetVerdict[] = []) {}
  async check(): Promise<BudgetVerdict> { return this.verdicts.shift() ?? { ok: true }; }
}
