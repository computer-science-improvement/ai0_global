import { AsyncLocalStorage } from 'async_hooks';

/** Attribution of LLM calls made inside a unit of work (spec 029 FR-002). */
export interface LlmContext {
  feature?:     string;
  agentId?:     string | null;
  agentHandle?: string | null;
  role?:        string | null;
  runId?:       string | null;
  stepIdx?:     number | null;
  resourceRef?: string | null;
  shadow?:      boolean;
}

const storage = new AsyncLocalStorage<LlmContext>();

/**
 * Run `fn` with LLM attribution. Nested contexts inherit the outer one and
 * override only the fields they set (undefined fields are inherited). The
 * context follows `fn` through awaits, timers and callbacks it schedules.
 */
export function withLlmContext<T>(ctx: LlmContext, fn: () => T): T {
  const outer = storage.getStore();
  const merged: LlmContext = { ...outer };
  for (const [k, v] of Object.entries(ctx)) if (v !== undefined) (merged as any)[k] = v;
  return storage.run(merged, fn);
}

/** The attribution in effect here, or an empty object outside any context. */
export function currentLlmContext(): LlmContext {
  return storage.getStore() ?? {};
}
