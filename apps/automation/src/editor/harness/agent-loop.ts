import type { ChatMessage, EditorRole, LlmClient, ToolCall } from '../llm/llm.types';
import type { ModelProfile } from '../llm/model-registry';
import type { AgentBudget, BudgetGate } from './budget.service';
import type { RunRecorder, RunStatus, RunTotals } from './run-recorder';
import { EditorTool, ToolContext, ToolError, isToolError, toToolSpec } from './tool';
import { toToolContent } from './truncate';
import { elideOldToolResults } from './context-trim';
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
  /**
   * Spend-ledger attribution override (spec 034 FR-012: an owner's dry-run preview is `editor.preview`, never shadow; spec 040
   * FR-001: an owner chat turn is `editor.chat.<role>`).
   */
  usage?:            { feature?: string; shadow?: boolean };
  /** The run's own spend cap (spec 040 FR-001, a chat turn's EDITOR_CHAT_TURN_MAX_USD): reaching it ends the run `budget_exceeded`. */
  maxCostUsd?:       number | null;
  /** Spec 053 FR-002: false for a run that is one call (the critic): no prompt-cache breakpoints, nothing reads them back. */
  cache?:            boolean;
  /** Spec 053 FR-002: the caller gave up on the run (a timed-out critic): no further steps, the HTTP call is cancelled. */
  signal?:           AbortSignal;
}

export interface AgentLoopResult {
  runId:           string | null;
  status:          RunStatus;
  terminalTool?:   string;
  terminalResult?: unknown;
  finalText?:      string | null;
  totals:          RunTotals;
  error?:          string;
  /** The last non-empty assistant text of the run (spec 040 FR-003: what the owner sees when the run ends without an answer). */
  lastText?:       string | null;
  /** Tools that succeeded in this run, in call order (what was done before an early stop). */
  toolsOk?:        string[];
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
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Arguments without the properties a model filled with a placeholder ("" or the nil UUID), at any depth; same object when none. */
export function dropPlaceholders(v: unknown): unknown {
  if (Array.isArray(v)) {
    const out = v.map(dropPlaceholders);
    return out.some((x, i) => x !== v[i]) ? out : v;
  }
  if (!v || typeof v !== 'object') return v;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x === '' || x === NIL_UUID) { changed = true; continue; }
    const y = dropPlaceholders(x);
    if (y !== x) changed = true;
    out[k] = y;
  }
  return changed ? out : v;
}

/** A leaked tool-call tag at the end of a string argument («…}</parameter>», «…]</invoke>»). */
const LEAKED_TAG_RE = /(?:\s*<\/?[A-Za-z_][\w:-]*>)+\s*$/u;

/**
 * Spec 046 FR-009: nested objects / arrays a model sent as JSON strings (the onboarder's submit_channel_setup failed 2/4
 * so), decoded at any depth — a leaked tool-call tag after the JSON is dropped first. Same value when nothing decodes.
 */
export function decodeJsonStrings(v: unknown): unknown {
  if (typeof v === 'string') {
    const t = v.trim().replace(LEAKED_TAG_RE, '');
    if (!/^[[{]/.test(t)) return v;
    try {
      const parsed = JSON.parse(t);
      return parsed && typeof parsed === 'object' ? decodeJsonStrings(parsed) : v;
    } catch {
      return v;
    }
  }
  if (Array.isArray(v)) {
    const out = v.map(decodeJsonStrings);
    return out.some((x, i) => x !== v[i]) ? out : v;
  }
  if (!v || typeof v !== 'object') return v;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const y = decodeJsonStrings(x);
    if (y !== x) changed = true;
    out[k] = y;
  }
  return changed ? out : v;
}

/** The error code of a tool result ('' for a success). */
function errorCode(output: unknown): string {
  return isToolError(output) ? String(output.error) : '';
}

/**
 * Whether an identical retry of this failed call is pointless. Not for a crash or timeout (`tool_failed`, may be transient),
 * nor for an error that grants turns to act on it (a critic `revise`: the critic judges the text, not the call).
 */
function rememberFailure(output: unknown): boolean {
  const code = errorCode(output);
  return !!code && code !== 'tool_failed' && code !== 'tool_dropped' && code !== 'repeated_failed_call'
    && (output as { _grantSteps?: unknown })._grantSteps === undefined;
}

/**
 * A verbatim repeat of a failed call, answered without running the tool (spec 040 FR-002 / FR-005): the earlier error, its
 * list of problems as a numbered checklist (a rejected plan), or its details.
 */
function repeatOutcome(raw: string, code: string, prev: ToolError) {
  const output: Record<string, unknown> = { error: code, details: `${prev.error} — this exact call already failed in this run; change the arguments or stop` };
  const str = (d: unknown) => (typeof d === 'string' ? d : JSON.stringify(d));
  if (Array.isArray(prev.details)) output.checklist = prev.details.slice(0, 20).map((d, i) => `${i + 1}. ${str(d)}`.slice(0, 400));
  else if (prev.details !== undefined) output.previous = str(prev.details).slice(0, 1500);
  return { input: parseArgs(raw), output, isError: true, terminal: false, durationMs: 0 };
}

/** A call the circuit breaker answers without running the tool (spec 040 FR-002). */
function blockedOutcome(raw: string, error: string, details: string) {
  return { input: parseArgs(raw), output: { error, details }, isError: true, terminal: false, durationMs: 0 };
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
    feature: input.usage?.feature ?? editorFeature(input.role), role: input.role, runId,
    agentId: input.agent?.id ?? null, agentHandle: input.agent?.handle ?? null,
    resourceRef: x.platformSlot?.resourceRef ?? (input.channelKey ? telegramResource(input.channelKey) : null),
    shadow: input.usage?.shadow ?? shadow,
  };
}

/** Stable JSON of a call's arguments (object keys sorted), so the same call with reordered keys is the same call. */
export function canonicalArgs(raw: string): string {
  let v: unknown;
  try { v = raw?.trim() ? JSON.parse(raw) : {}; } catch { return String(raw ?? '').trim(); }
  const sort = (x: unknown): unknown => Array.isArray(x) ? x.map(sort)
    : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])]))
    : x;
  return JSON.stringify(sort(v));
}

/** Spec 040 FR-002: errors with the same (tool, code) in one run after which the tool is dropped (terminal tools never are). */
export const MAX_SAME_TOOL_ERRORS = 3;

const MAX_FINISH_NUDGES = 1;
const MAX_EMPTY_RETRIES = 1;
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
    // Circuit breaker (spec 040 FR-002): calls that failed (never re-run verbatim), error counts per (tool, code), dropped tools.
    const failedCalls = new Map<string, ToolError>();
    const errorCounts = new Map<string, number>();
    const dropped = new Set<string>();
    let repeatBlocked = 0;
    // Spec 053 FR-002: one tool list for the run. Tools open the provider's cached prefix, so swapping them re-writes the
    // whole prompt at the cache-write price: the last turn keeps every tool and says in text that only a terminal one
    // counts. A tool dropped by the breaker still leaves the list (rare, and a stubborn model keeps calling what it sees).
    const allSpecs = input.tools.map(toToolSpec);
    const liveSpecs = () => (dropped.size ? allSpecs.filter((t) => !dropped.has(t.name)) : allSpecs);
    const terminalNames = input.tools.filter((t) => t.kind === 'terminal').map((t) => t.name);
    const toolOfCall = new Map<string, string>();
    let graceUsed = false;

    let runId: string;
    try {
      runId = await this.deps.recorder.start({
        role: input.role, channelKey: input.channelKey, slotId: input.slotId, model: input.model.model, agentId: input.agent?.id ?? null,
        toolsOffered: input.tools.map((t) => t.name),
      });
    } catch (err: any) {
      return { runId: null, status: 'error', totals, error: `run start failed: ${err.message}` };
    }

    let lastText: string | null = null;
    const toolsOk: string[] = [];
    const finish = async (status: RunStatus, extra: Partial<AgentLoopResult> = {}): Promise<AgentLoopResult> => {
      try {
        await this.deps.recorder.finish(runId, status, totals, extra.error ?? null, { repeatBlocked, toolsDropped: [...dropped] });
      } catch { /* trace only */ }
      return { runId, status, totals, lastText, toolsOk, ...extra };
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
    let empties = 0;

    try {
      for (let turn = 0; turn < maxSteps; turn++) {
        if (input.signal?.aborted) return finish('error', { error: 'aborted by the caller' });
        if (input.maxCostUsd != null && input.maxCostUsd > 0 && totals.costUsd >= input.maxCostUsd) {
          return finish('budget_exceeded', { error: `turn budget: $${totals.costUsd.toFixed(4)} >= $${input.maxCostUsd}` });
        }
        const verdict = await withLlmContext(usage, () => this.deps.budget.check(input.channelKey, input.channelBudgetUsd, input.agent ?? null, input.model.workspace ?? 'openrouter'));
        if (!verdict.ok) {
          const key = verdict.key ? ` (${verdict.key})` : '';
          return finish('budget_exceeded', { error: `${verdict.scope} budget${key}: $${verdict.spentUsd.toFixed(4)} >= $${verdict.limitUsd}` });
        }

        const lastTurn = turn === maxSteps - 1 && terminalNames.length > 0;
        if (lastTurn) {
          messages.push({ role: 'user', content: `Це останній крок. Заверши роботу зараз викликом одного з інструментів: ${terminalNames.join(', ')} — інші інструменти вже не виконуються. Якщо матеріалу для поста не вистачає — пропусти слот і коротко назви причину.` });
        }
        // Spec 053 FR-003: old tool results give way to stubs once the run's results pass the cap.
        elideOldToolResults(messages, (id) => toolOfCall.get(id));
        const t0 = now();
        const res = await withLlmContext({ ...usage, stepIdx: totals.steps }, () => this.deps.llm.chat({
          model: input.model.model, messages, tools: liveSpecs(),
          maxTokens: input.model.maxTokens, temperature: input.model.temperature, reasoningEffort: input.model.reasoningEffort,
          ...(input.model.workspace === 'anthropic' ? { provider: 'anthropic' as const } : {}),
          ...(input.cache === false ? { cache: false } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        }));
        totals.promptTokens     += res.usage.promptTokens;
        totals.completionTokens += res.usage.completionTokens;
        totals.costUsd          += res.usage.costUsd;
        await this.deps.recorder.llmStep(runId, totals.steps++, res, now() - t0);
        messages.push(res.message);
        if (res.message.content?.trim()) {
          lastText = res.message.content.trim();
          emit({ type: 'llm_text', text: res.message.content });
        }

        const calls = res.message.toolCalls ?? [];
        if (!calls.length && res.finishReason === 'length' && !(res.message.content ?? '').trim() && truncations < MAX_TRUNCATION_RETRIES) {
          // Reasoning models can spend the whole max_tokens thinking and return nothing — that is not an answer.
          truncations++;
          messages.pop();
          messages.push({ role: 'user', content: 'Відповідь обірвалась до результату. Думай коротше і одразу дій: виклич потрібний інструмент.' });
          continue;
        }
        if (!calls.length && !(res.message.content ?? '').trim() && res.usage.completionTokens === 0 && empties < MAX_EMPTY_RETRIES) {
          // An empty 0-token completion is a provider hiccup, not an answer (spec 040 FR-003): ask again once.
          empties++;
          messages.pop();
          continue;
        }
        if (!calls.length) {
          if (terminalNames.length && nudges < MAX_FINISH_NUDGES) {
            nudges++;
            messages.push({ role: 'user', content: `Заверши роботу викликом одного з інструментів: ${terminalNames.join(', ')}.` });
            continue;
          }
          // A role that ends with a terminal tool did not (spec 040 FR-003): not a success, whatever the text says.
          if (terminalNames.length) return finish('no_terminal', { finalText: res.message.content, error: 'ended without a terminal tool' });
          return finish('ok', { finalText: res.message.content });
        }

        const notes: string[] = [];
        let lastTurnBlocked = false;
        for (const call of calls) {
          if (input.onEvent) emit({ type: 'tool_call', name: call.name, args: parseArgs(call.arguments) });
          const stepCtx = { ...usage, stepIdx: totals.steps };
          const callKey = `${call.name}\u0000${canonicalArgs(call.arguments)}`;
          const previous = failedCalls.get(callKey);
          // LLM calls a tool makes itself are attributed to the run's feature, but without run/step ids:
          // (run_id, step_idx) belongs to the tool step row.
          const lateCall = lastTurn && byName.has(call.name) && byName.get(call.name)!.kind !== 'terminal';
          if (lateCall) lastTurnBlocked = true;
          const outcome = lateCall
            ? blockedOutcome(call.arguments, 'last_turn', `це був останній крок — ${call.name} не виконано; виклич ${terminalNames.join(' або ')}`)
            : previous !== undefined
            ? repeatOutcome(call.arguments, byName.get(call.name)?.repeatError ?? 'repeated_failed_call', previous)
            : dropped.has(call.name)
              ? blockedOutcome(call.arguments, 'tool_dropped', `${call.name} is off for the rest of this run after ${MAX_SAME_TOOL_ERRORS} errors of the same kind`)
              : await withLlmContext({ ...usage, runId: null }, () => this.runTool(call, byName, ctx, toolTimeoutMs));
          if (previous !== undefined) repeatBlocked++;
          if (input.onEvent) emit({ type: 'tool_result', name: call.name, ok: !outcome.isError, summary: summarize(outcome.output) });
          // Paid tools (e.g. web_search) report their own spend so it counts against the budget.
          const toolCost = typeof (outcome.output as any)?._costUsd === 'number' ? (outcome.output as any)._costUsd as number : 0;
          totals.costUsd += toolCost;
          await withLlmContext(stepCtx, () => this.deps.recorder.toolStep(runId, totals.steps++, call, outcome.input, outcome.output, outcome.isError, outcome.durationMs, toolCost || null));
          toolOfCall.set(call.id, call.name);
          messages.push({ role: 'tool', toolCallId: call.id, content: toToolContent(outcome.output, byName.get(call.name)?.maxResultChars) });
          if (!outcome.isError) toolsOk.push(call.name);
          else {
            const code = errorCode(outcome.output);
            if (previous === undefined && rememberFailure(outcome.output)) failedCalls.set(callKey, outcome.output as ToolError);
            const k = `${call.name}\u0000${code}`;
            const n = (errorCounts.get(k) ?? 0) + 1;
            errorCounts.set(k, n);
            const tool = byName.get(call.name);
            if (n >= MAX_SAME_TOOL_ERRORS && tool && tool.kind !== 'terminal' && !tool.keepOnError && !dropped.has(call.name)) {
              dropped.add(call.name);
              notes.push(`Інструмент ${call.name} вимкнено до кінця цього прогону: ${n} помилки «${code}». Зроби інакше або заверши роботу.`);
            }
          }
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
        // After every tool result of this turn (the API wants them right after the assistant message).
        if (notes.length) messages.push({ role: 'user', content: notes.join('\n') });
        // Spec 053 FR-002: the last turn keeps every tool, so a model may still reach for research — one more turn, once.
        if (lastTurnBlocked && !graceUsed && turn === maxSteps - 1) {
          graceUsed = true;
          maxSteps += 1;
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
    // A plan's optional fields filled with "" or the nil UUID pass the schema (the nil UUID is a UUID) but are not values.
    if (tool.placeholdersAbsent) args = dropPlaceholders(args);
    let parsed = tool.input.safeParse(args);
    if (!parsed.success) {
      // Spec 040 FR-005: models fill optional fields with "" or the nil UUID; read those as absent before giving up.
      const cleaned = dropPlaceholders(args);
      if (cleaned !== args) {
        const again = tool.input.safeParse(cleaned);
        if (again.success) parsed = again;
      }
      // Spec 046 FR-009: objects sent as JSON strings are read as the objects (only when that makes the call valid).
      const decoded = parsed.success ? args : decodeJsonStrings(args);
      if (decoded !== args) {
        const again = tool.input.safeParse(dropPlaceholders(decoded));
        if (again.success) { parsed = again; args = decoded; }
      }
    }
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
