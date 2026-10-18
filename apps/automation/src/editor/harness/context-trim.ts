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

export function elidedStub(tool: string, chars: number): string {
  return JSON.stringify({
    elided: true, tool, chars,
    note: 'Старий результат прибрано, щоб скоротити контекст. Потрібен ще — виклич інструмент знову.',
  });
}

/**
 * Replace old tool results in `messages` (in place). `toolOf` maps a tool call id to its tool name. Returns how many
 * results were elided (0 when the run is under the cap).
 */
export function elideOldToolResults(
  messages: ChatMessage[], toolOf: (callId: string) => string | undefined,
  o: { maxChars?: number; targetChars?: number } = {},
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
    const stub = elidedStub(toolOf(m.toolCallId) ?? 'tool', m.content.length);
    if (stub.length >= m.content.length) continue;
    total -= m.content.length - stub.length;
    messages[i] = { ...m, content: stub };
    elided++;
  }
  return elided;
}
