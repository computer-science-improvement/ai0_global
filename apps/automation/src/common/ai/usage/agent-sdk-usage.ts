import { classifyError, isBudgetExceeded, llmUsage, type LlmUsageRecorder } from './llm-usage.service';

/** The parts of an Agent SDK result message the ledger reads. */
interface SdkResult {
  type:            'result';
  subtype:         string;
  result?:         string;
  total_cost_usd?: number;
  usage?:          { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?:     Record<string, unknown>;
}

/**
 * Consume an Agent SDK `query()` stream and write one llm_usage row for it
 * (spec 029 FR-003): `total_cost_usd` (source provider), tokens from the
 * result's `usage`, the model from `modelUsage`. Returns the trimmed result
 * text of a successful run, otherwise null. A stream that throws records an
 * error/timeout row and rethrows, so the caller's catch path still runs.
 */
export async function runTrackedQuery(
  start: () => AsyncIterable<any>,
  meta: { feature: string; usage?: LlmUsageRecorder },
): Promise<string | null> {
  const usage = meta.usage ?? llmUsage();
  const t0 = Date.now();
  let result: SdkResult | null = null;
  try {
    for await (const msg of start()) {
      if (msg?.type === 'result') result = msg as SdkResult;
    }
  } catch (err) {
    const c = classifyError(err);
    usage.record({ provider: 'agent_sdk', model: 'agent-sdk', feature: meta.feature, status: c.status, errorCode: c.errorCode,
      costUsd: 0, costSource: 'provider', latencyMs: Date.now() - t0 });
    throw err;
  }
  if (!result) {
    usage.record({ provider: 'agent_sdk', model: 'agent-sdk', feature: meta.feature, status: 'error', errorCode: 'no_result',
      costUsd: 0, costSource: 'provider', latencyMs: Date.now() - t0 });
    return null;
  }
  const u = result.usage ?? {};
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const ok = result.subtype === 'success';
  usage.record({
    provider: 'agent_sdk', model: Object.keys(result.modelUsage ?? {})[0] ?? 'agent-sdk', feature: meta.feature,
    tokensIn: (u.input_tokens ?? 0) + read + write, tokensOut: u.output_tokens ?? 0, tokensCachedRead: read, tokensCachedWrite: write,
    costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : 0, costSource: 'provider',
    status: ok ? 'ok' : 'error', errorCode: ok ? null : result.subtype, latencyMs: Date.now() - t0,
  });
  return ok ? (result.result?.trim() || null) : null;
}

/**
 * Budget gate before an Agent SDK call: true when the call may run. A
 * blocking cap refuses it (the caller takes its fail-open path); a failing
 * budget check lets it through.
 */
export async function agentSdkAllowed(feature: string, warn: (msg: string) => void, usage: LlmUsageRecorder = llmUsage()): Promise<boolean> {
  try {
    await usage.guard('agent_sdk', { feature });
    return true;
  } catch (err: any) {
    if (isBudgetExceeded(err)) { warn(`${feature} refused: ${err.message}`); return false; }
    warn(`budget check failed, ${feature} proceeds: ${err?.message ?? err}`);
    return true;
  }
}
