import type { ChatMessage } from '../llm/llm.types';

/**
 * Spec 053 FR-003: every step of a run re-sends every earlier tool result, so a long run pays for the same pages and
 * lists again and again. When the tool results of a run pass TOOL_CONTEXT_MAX_CHARS, the oldest ones are replaced by a
 * short stub — in one batch, down to TOOL_CONTEXT_TARGET_CHARS, so the provider's prompt cache breaks once, not on
 * every step. Kept: the results of the newest assistant turn and the newest result of each tool.
 */
export const TOOL_CONTEXT_MAX_CHARS = 40_000;
export const TOOL_CONTEXT_TARGET_CHARS = 20_000;

const ELIDED_MARK = '"elided":true';

/** The one-line gist of an elided result (spec 064 FR-005): its title when it has one, else its first characters. */
export const GIST_CHARS = 160;
const ARGS_CHARS = 200;

export function gistOf(content: string): string {
  try {
    const v = JSON.parse(content) as unknown;
    const title = v && typeof v === 'object' && !Array.isArray(v) ? (v as { title?: unknown }).title : undefined;
    if (typeof title === 'string' && title.trim()) return title.trim().slice(0, GIST_CHARS);
  } catch { /* not JSON: fall through to the plain start */ }
  return content.replace(/\s+/g, ' ').trim().slice(0, GIST_CHARS);
}

/**
 * What an old tool result is replaced with: the tool, the call's arguments (its URL) and a one-line gist, so the model
 * knows what it already read and does not fetch it again (spec 064 FR-005; the 053 stub said «call the tool again»).
 */
export function elidedStub(tool: string, chars: number, o: { args?: string; gist?: string } = {}): string {
  return JSON.stringify({
    elided: true, tool, chars,
    ...(o.args ? { args: o.args.slice(0, ARGS_CHARS) } : {}),
    ...(o.gist ? { gist: o.gist } : {}),
    note: 'Старий результат прибрано, щоб скоротити контекст. Повторний виклик лише якщо потрібні деталі, яких немає в gist.',
  });
}

/**
 * Replace old tool results in `messages` (in place). `toolOf` maps a tool call id to its tool name; `argsOf` (optional) to the
 * call's raw arguments, which the stub keeps. Returns how many
 * results were elided (0 when the run is under the cap).
 */
export function elideOldToolResults(
  messages: ChatMessage[], toolOf: (callId: string) => string | undefined,
  o: { maxChars?: number; targetChars?: number; argsOf?: (callId: string) => string | undefined } = {},
): number {
  const maxChars = o.maxChars ?? TOOL_CONTEXT_MAX_CHARS;
  const target = o.targetChars ?? TOOL_CONTEXT_TARGET_CHARS;
  const tools: number[] = [];
  let total = 0;
  messages.forEach((m, i) => {
    if (m.role !== 'tool') return;
    tools.push(i);
    total += m.content.length;
  });
  if (total <= maxChars) return 0;

  let lastAssistant = -1;
  messages.forEach((m, i) => { if (m.role === 'assistant') lastAssistant = i; });
  const newestOf = new Map<string, number>();
  for (const i of tools) newestOf.set(toolOf((messages[i] as { toolCallId: string }).toolCallId) ?? '?', i);
  const kept = new Set(newestOf.values());

  let elided = 0;
  for (const i of tools) {
    if (total <= target) break;
    const m = messages[i] as Extract<ChatMessage, { role: 'tool' }>;
    if (i > lastAssistant || kept.has(i) || m.content.includes(ELIDED_MARK)) continue;
    const stub = elidedStub(toolOf(m.toolCallId) ?? 'tool', m.content.length, { args: o.argsOf?.(m.toolCallId), gist: gistOf(m.content) });
    if (stub.length >= m.content.length) continue;
    total -= m.content.length - stub.length;
    messages[i] = { ...m, content: stub };
    elided++;
  }
  return elided;
}
