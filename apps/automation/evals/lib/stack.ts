import type { Pool } from 'pg';
import { AgentLoop } from '../../src/editor/harness/agent-loop';
import { ToolRegistry } from '../../src/editor/harness/tool-registry';
import { PgRunRecorder } from '../../src/editor/harness/run-recorder';
import { BudgetService } from '../../src/editor/harness/budget.service';
import { OpenRouterClient } from '../../src/editor/llm/openrouter.client';
import type { LlmClient, LlmRequest, LlmResponse } from '../../src/editor/llm/llm.types';
import { ReadonlyQueryService } from '../../src/editor/db/readonly-query.service';
import { SkillLibrary } from '../../src/editor/skills/skill-library';
import { buildReadTools } from '../../src/editor/tools/read-tools';
import { buildComposeTools } from '../../src/editor/tools/compose-tools';
import { buildRoleTools } from '../../src/editor/tools/role-tools';
import { EditorChannelsRepository } from '../../src/editor/repo/editor-channels.repository';
import { EditorPlansRepository } from '../../src/editor/repo/editor-plans.repository';
import { EditorMemoryRepository } from '../../src/editor/repo/editor-memory.repository';
import { EditorRunnerService } from '../../src/editor/roles/editor-runner.service';
import type { TgMessage } from '../../src/editor/post/render-telegram';
import type { FakeWeb } from './fake-web';

/** Counts LLM calls/cost of the agent under test (separately from the judge). */
class CountingLlm implements LlmClient {
  calls = 0;
  costUsd = 0;
  constructor(private readonly inner: LlmClient) {}
  async chat(req: LlmRequest): Promise<LlmResponse> {
    this.calls++;
    const res = await this.inner.chat(req);
    this.costUsd += res.usage.costUsd;
    return res;
  }
}

export interface EvalStack {
  pool:     Pool;
  channels: EditorChannelsRepository;
  plans:    EditorPlansRepository;
  memory:   EditorMemoryRepository;
  runner:   EditorRunnerService;
  llm:      CountingLlm;
  sent:     Array<{ channelKey: string; messages: TgMessage[] }>;
  previews: string[];
  notes:    string[];
}

/**
 * The production editor wiring (same tools, prompts, guards, loop, budget,
 * trace) with three substitutions: the web is FakeWeb, Telegram is a recorder,
 * and the clock is fixed. The LLM is REAL (OpenRouter).
 */
export function buildStack(o: { pool: Pool; web: FakeWeb; now: () => Date; apiKey: string; env: (k: string) => string | undefined }): EvalStack {
  const { pool, web, now } = o;
  const channels = new EditorChannelsRepository(pool);
  const plans = new EditorPlansRepository(pool);
  const memory = new EditorMemoryRepository(pool);
  const skills = new SkillLibrary();
  const sent: EvalStack['sent'] = [];
  const previews: string[] = [];
  const notes: string[] = [];
  let msgId = 50_000;

  const registry = new ToolRegistry([
    ...buildReadTools({ pool, readonly: new ReadonlyQueryService(pool), skills, http: web.http }),
    ...buildComposeTools({ http: web.http }),
    ...buildRoleTools({
      pool, plans, memory, channels, now,
      publisher: { send: async (channelKey, messages) => { sent.push({ channelKey, messages }); return { messageIds: messages.map(() => msgId++) }; } },
      recordPublish: () => {},
      notifyPreview: async (_k, html) => { previews.push(html); },
    }),
  ]);

  const llm = new CountingLlm(new OpenRouterClient({ apiKey: o.apiKey, baseUrl: o.env('OPENROUTER_BASE_URL') }));
  const loop = new AgentLoop({
    llm,
    recorder: new PgRunRecorder(pool, (m) => notes.push(m)),
    budget: new BudgetService(pool, { globalDailyUsd: 50, channelDailyUsd: 50 }),
    enabled: () => true,
  });
  const runner = new EditorRunnerService({
    loop, registry, skills, plans, memory, now,
    env: o.env,
    notify: async (t) => { notes.push(t); },
  });
  return { pool, channels, plans, memory, runner, llm, sent, previews, notes };
}
