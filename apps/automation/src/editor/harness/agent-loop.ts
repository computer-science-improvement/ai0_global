import type { ChatMessage, EditorRole, LlmClient, ToolCall } from '../llm/llm.types';
import type { ModelProfile } from '../llm/model-registry';
import type { AgentBudget, BudgetGate } from './budget.service';
import type { RunRecorder, RunStatus, RunTotals } from './run-recorder';
import { EditorTool, ToolContext, isToolError, toToolSpec } from './tool';
import { toToolContent } from './truncate';
import { withLlmContext, type LlmContext } from '../../common/ai/usage/llm-context';
import { editorFeature, telegramResource } from '../../common/ai/usage/features';

export interface AgentLoopDeps {
  llm:            LlmClient;
  recorder:       RunRecorder;
  budget:         BudgetGate;
  enabled:        () => boolean;
  toolTimeoutMs?: number;
  now?:           () => number;
}

/** Streaming events for a live UI (spec 010). Delivered best-effort: a throwing listener never breaks the run. */
export type AgentLoopEvent =
  | { type: 'llm_text';    text: string }
  | { type: 'tool_call';   name: string; args: unknown }
  | { type: 'tool_result'; name: string; ok: boolean; summary: string };

/** Prior text turns of a conversation (only user / assistant text is kept). */
export const MAX_HISTORY_TURNS = 20;

export interface AgentLoopInput {
  role:              EditorRole;
  channelKey:        string | null;
  slotId?:           string | null;
  model:             ModelProfile;
  system:            string;
  user:              string;
  tools:             EditorTool[];
  maxSteps?:         number;
  channelBudgetUsd?: number | null;
  extras?:           Record<string, unknown>;
  /** Prior user/assistant text turns, inserted between the system prompt and `user` (last MAX_HISTORY_TURNS). */
  history?:          ChatMessage[];
  onEvent?:          (e: AgentLoopEvent) => void;
  /** Registry agent of this run (spec 017): recorded on the run and checked against its own daily budget. */
  agent?:            AgentBudget | null;
}

export interface AgentLoopResult {
  runId:           string | null;
  status:          RunStatus;
  terminalTool?:   string;
  terminalResult?: unknown;
  finalText?:      string | null;
  totals:          RunTotals;
  error?:          string;
}

const DEFAULT_MAX_STEPS = 12;
const SUMMARY_CHARS = 160;

function parseArgs(raw: string): unknown {
  try { return raw?.trim() ? JSON.parse(raw) : {}; } catch { return raw; }
}

/** One short line about a tool result for a live UI: the error code (+details) or the start of the JSON. */
function summarize(output: unknown): string {
  if (isToolError(output)) {
    const d = output.details === undefined ? '' : `: ${typeof output.details === 'string' ? output.details : JSON.stringify(output.details)}`;
    return `${output.error}${d}`.slice(0, SUMMARY_CHARS);
  }
  let s: string;
  try { s = JSON.stringify(output) ?? ''; } catch { s = String(output); }
  return s.length > SUMMARY_CHARS ? `${s.slice(0, SUMMARY_CHARS)}…` : s;
}
/**
 * Spend-ledger attribution of a run (spec 029): editor.<role>, the agent, the
 * resource and whether it is a shadow run (the runners put the card, the
 * orchestrator and platform-slot mode into extras; chat and builder runs are owner-initiated, never shadow).
 */
function usageAttribution(input: AgentLoopInput, runId: string): LlmContext {
  const x = (input.extras ?? {}) as { card?: { mode?: string }; orchestrator?: { mode?: string } | null; platformSlot?: { mode?: string; resourceRef?: string } };
  const shadow = x.platformSlot?.mode ? x.platformSlot.mode === 'shadow'
    : input.role === 'composer' || input.role === 'builder' ? false
    : x.card?.mode === 'shadow' || x.orchestrator?.mode === 'shadow';
  return {
    feature: editorFeature(input.role), role: input.role, runId,
    agentId: input.agent?.id ?? null, agentHandle: input.agent?.handle ?? null,
    resourceRef: x.platformSlot?.resourceRef ?? (input.channelKey ? telegramResource(input.channelKey) : null),
    shadow,
  };
}

const MAX_FINISH_NUDGES = 1;
/** The most turns a tool error can add to a run (`_grantSteps`), once per run. */
export const MAX_GRANT_STEPS = 3;
const MAX_TRUNCATION_RETRIES = 2;

/**
 * The editor's tool-calling loop. Model proposes tool calls; this loop
 * validates and executes them and feeds results back. It ends when a terminal
 * tool succeeds, the model answers without tools, the step cap or the budget
 * is hit. It NEVER throws: every failure becomes a run status.
 */
export class AgentLoop {
  constructor(private readonly deps: AgentLoopDeps) {}

  async run(input: AgentLoopInput): Promise<AgentLoopResult> {
    const totals: RunTotals = { steps: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
    if (!this.deps.enabled()) return { runId: null, status: 'disabled', totals };

    const now = this.deps.now ?? Date.now;
    const toolTimeoutMs = this.deps.toolTimeoutMs ?? 30_000;
    let maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
    let granted = false;
    const byName = new Map(input.tools.map((t) => [t.name, t]));
    const specs = input.tools.map(toToolSpec);
    // The last turn may only end the run: a role that has terminal tools must not run out of turns mid-research.
    const terminalSpecs = input.tools.filter((t) => t.kind === 'terminal').map(toToolSpec);
    const terminalNames = input.tools.filter((t) => t.kind === 'terminal').map((t) => t.name);

    let runId: string;
    try {
      runId = await this.deps.recorder.start({
        role: input.role, channelKey: input.channelKey, slotId: input.slotId, model: input.model.model, agentId: input.agent?.id ?? null,
      });
    } catch (err: any) {
      return { runId: null, status: 'error', totals, error: `run start failed: ${err.message}` };
    }

    const finish = async (status: RunStatus, extra: Partial<AgentLoopResult> = {}): Promise<AgentLoopResult> => {
      try { await this.deps.recorder.finish(runId, status, totals, extra.error ?? null); } catch { /* trace only */ }
      return { runId, status, totals, ...extra };
    };

    const usage = usageAttribution(input, runId);
    const ctx: ToolContext = { runId, role: input.role, channelKey: input.channelKey, slotId: input.slotId ?? null, extras: input.extras };
    const history = (input.history ?? [])
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length > 0)
      .map((m) => ({ role: m.role, content: m.content as string }) as ChatMessage)
      .slice(-MAX_HISTORY_TURNS);
    const messages: ChatMessage[] = [
      { role: 'system', content: input.system },
      ...history,
      { role: 'user', content: input.user },
    ];
    const emit = (e: AgentLoopEvent) => {
      if (!input.onEvent) return;
      try { input.onEvent(e); } catch { /* a listener (e.g. a closed HTTP stream) never breaks the run */ }
    };
    let nudges = 0;
    let truncations = 0;

    try {
      for (let turn = 0; turn < maxSteps; turn++) {
        const verdict = await withLlmContext(usage, () => this.deps.budget.check(input.channelKey, input.channelBudgetUsd, input.agent ?? null));
        if (!verdict.ok) return finish('budget_exceeded', { error: `${verdict.scope} budget: $${verdict.spentUsd.toFixed(4)} >= $${verdict.limitUsd}` });

        const lastTurn = turn === maxSteps - 1 && terminalSpecs.length > 0;
        if (lastTurn) {
          messages.push({ role: 'user', content: `Це останній крок. Заверши роботу зараз викликом одного з інструментів: ${terminalSpecs.map((t) => t.name).join(', ')}. Якщо матеріалу для поста не вистачає — пропусти слот і коротко назви причину.` });
        }
        const t0 = now();
        const res = await withLlmContext({ ...usage, stepIdx: totals.steps }, () => this.deps.llm.chat({
          model: input.model.model, messages, tools: lastTurn ? terminalSpecs : specs,
          maxTokens: input.model.maxTokens, temperature: input.model.temperature, reasoningEffort: input.model.reasoningEffort,
        }));
        totals.promptTokens     += res.usage.promptTokens;
        totals.completionTokens += res.usage.completionTokens;
        totals.costUsd          += res.usage.costUsd;
        await this.deps.recorder.llmStep(runId, totals.steps++, res, now() - t0);
        messages.push(res.message);
        if (res.message.content?.trim()) emit({ type: 'llm_text', text: res.message.content });

        const calls = res.message.toolCalls ?? [];
        if (!calls.length && res.finishReason === 'length' && !(res.message.content ?? '').trim() && truncations < MAX_TRUNCATION_RETRIES) {
          // Reasoning models can spend the whole max_tokens thinking and return nothing — that is not an answer.
          truncations++;
          messages.pop();
          messages.push({ role: 'user', content: 'Відповідь обірвалась до результату. Думай коротше і одразу дій: виклич потрібний інструмент.' });
          continue;
        }
        if (!calls.length) {
          if (terminalNames.length && nudges < MAX_FINISH_NUDGES) {
            nudges++;
            messages.push({ role: 'user', content: `Заверши роботу викликом одного з інструментів: ${terminalNames.join(', ')}.` });
            continue;
          }
          return finish('ok', { finalText: res.message.content });
        }

        for (const call of calls) {
          if (input.onEvent) emit({ type: 'tool_call', name: call.name, args: parseArgs(call.arguments) });
          const stepCtx = { ...usage, stepIdx: totals.steps };
          // LLM calls a tool makes itself are attributed to the run's feature, but without run/step ids:
          // (run_id, step_idx) belongs to the tool step row.
          const outcome = await withLlmContext({ ...usage, runId: null }, () => this.runTool(call, byName, ctx, toolTimeoutMs));
          if (input.onEvent) emit({ type: 'tool_result', name: call.name, ok: !outcome.isError, summary: summarize(outcome.output) });
          // Paid tools (e.g. web_search) report their own spend so it counts against the budget.
          const toolCost = typeof (outcome.output as any)?._costUsd === 'number' ? (outcome.output as any)._costUsd as number : 0;
          totals.costUsd += toolCost;
          await withLlmContext(stepCtx, () => this.deps.recorder.toolStep(runId, totals.steps++, call, outcome.input, outcome.output, outcome.isError, outcome.durationMs, toolCost || null));
          messages.push({ role: 'tool', toolCallId: call.id, content: toToolContent(outcome.output) });
          if (outcome.terminal && !outcome.isError) {
            return finish('ok', { terminalTool: call.name, terminalResult: outcome.output });
          }
          // A tool error may ask for turns to act on it (spec 034: a critic `revise` near the step limit must still
          // end in publish or skip). Granted once per run, at most MAX_GRANT_STEPS turns after this one.
          const grant = outcome.isError ? Number((outcome.output as { _grantSteps?: unknown })?._grantSteps ?? 0) : 0;
          if (grant > 0 && !granted) {
            granted = true;
            maxSteps = Math.max(maxSteps, turn + 1 + Math.min(Math.floor(grant), MAX_GRANT_STEPS));
          }
        }
      }
      return finish('max_steps', { error: `no terminal tool after ${maxSteps} turns` });
    } catch (err: any) {
      return finish('error', { error: err?.message ?? String(err) });
    }
  }

  private async runTool(
    call: ToolCall, byName: Map<string, EditorTool>, ctx: ToolContext, timeoutMs: number,
  ): Promise<{ input: unknown; output: unknown; isError: boolean; terminal: boolean; durationMs: number }> {
    const t0 = Date.now();
    const done = (input: unknown, output: unknown, terminal = false) =>
      ({ input, output, isError: isToolError(output), terminal, durationMs: Date.now() - t0 });

    const tool = byName.get(call.name);
    if (!tool) return done(call.arguments, { error: 'tool_not_allowed', details: `unknown or disallowed tool "${call.name}"` });

    let args: unknown;
    try {
      args = call.arguments?.trim() ? JSON.parse(call.arguments) : {};
    } catch {
      return done(call.arguments, { error: 'invalid_json', details: 'arguments must be a JSON object' });
    }
    const parsed = tool.input.safeParse(args);
    if (!parsed.success) {
      return done(args, { error: 'invalid_args', details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      const ms = tool.timeoutMs ?? timeoutMs;
      const output = await Promise.race([
        tool.execute(parsed.data, ctx),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`tool timed out after ${ms}ms`)), ms); }),
      ]);
      return done(parsed.data, output ?? { ok: true }, tool.kind === 'terminal');
    } catch (err: any) {
      return done(parsed.data, { error: 'tool_failed', details: err?.message ?? String(err) });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
