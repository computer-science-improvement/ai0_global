import { z } from 'zod';
import type { AgentLoop, AgentLoopResult } from '../harness/agent-loop';
import { defineTool } from '../harness/tool';
import type { EditorRole } from '../llm/llm.types';
import { resolveModel } from '../llm/model-registry';
import { readModelContext, type Workspace } from '../llm/workspace';
import { PROBE_FEATURE } from '../roles/preview-run';
import type { SideCritic } from './skill-probe.types';
import { errText } from '../../common/err-text';

/** One side of the comparison, as the judge sees it. */
export interface JudgeSide {
  text:   string;
  /** The critic's verdict on the post and the lint warnings (code signals the judge may weigh). */
  critic: SideCritic;
  lint:   number;
  chars:  number;
}

export interface JudgeInput {
  /** The skill whose text differs between the two posts (the judge does not see which side has the new one). */
  skill:    string;
  topic:    string;
  platform: string;
  format:   string;
  /** The resource's brief, profile and owner rules, short. */
  context:  string | null;
  a:        JudgeSide;
  b:        JudgeSide;
}

export interface JudgeVerdict {
  better:  'A' | 'B' | 'same';
  reasons: string[];
  risks:   string[];
}

export type JudgeResult =
  | { ok: true; verdict: JudgeVerdict; costUsd: number }
  | { ok: false; error: string; costUsd: number };

/** The probe's judge: given the slot and two posts in random order, which one is better. A fake in tests. */
export interface PairwiseJudge {
  compare(i: JudgeInput, o: { channelKey: string | null; maxCostUsd: number }): Promise<JudgeResult>;
}

export const ComparisonInput = z.object({
  better:  z.enum(['A', 'B', 'same']),
  reasons: z.array(z.string().trim().min(1).max(300)).max(3).default([]),
  risks:   z.array(z.string().trim().min(1).max(300)).max(3).default([]),
});

export const JUDGE_TIMEOUT_MS = 90_000;
const JUDGE_MAX_STEPS = 2;
const CAP = { post: 3_500, context: 1_800 } as const;

const clip = (s: string | null | undefined, n: number): string => {
  const t = (s ?? '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export const JUDGE_SYSTEM = [
  'Ти порівнюєш два пости, написані для одного слота одним і тим самим автором, і вирішуєш, який кращий для читача цього ресурсу.',
  'Не знаєш, котрий пост «старий», а котрий «новий»: порядок випадковий. Не віддавай перевагу довшому чи першому лише за позицією.',
  'Критерії: правдивість і опора на джерело, голос і тон ресурсу, користь і конкретика для читача, відсутність AI-штампів, відповідність формату й правилам власника.',
  'Якщо різниця дрібна або пости рівні — «same». Якщо один пост порушує правила ресурсу чи вигадує факти — він гірший, навіть якщо звучить краще.',
  'Виклич submit_comparison один раз: better = A, B або same; reasons — до 3 коротких причин українською; risks — до 3 ризиків пост-переможця (порожньо, якщо нема).',
].join('\n');

export function judgeUserPrompt(i: JudgeInput): string {
  const side = (label: 'A' | 'B', s: JudgeSide) => [
    `## Пост ${label}`,
    clip(s.text, CAP.post) || '(порожньо)',
    `Сигнали коду: вердикт критика ${s.critic}; попереджень lint ${s.lint}; ${s.chars} символів.`,
  ].join('\n');
  return [
    `Ресурс: ${i.platform}. Формат: ${i.format}. Тема слота: ${i.topic}.`,
    `Між постами різниця лише в тексті одного скіла автора («${i.skill}»).`,
    ...(i.context ? ['', '## Ресурс: бриф, профіль, правила власника', clip(i.context, CAP.context)] : []),
    '', side('A', i.a), '', side('B', i.b), '', 'Порівняй і виклич submit_comparison.',
  ].join('\n');
}

export interface JudgeDeps {
  loop:          Pick<AgentLoop, 'run'>;
  env:           (key: string) => string | undefined;
  defaultModel?: (ws?: Workspace) => Promise<string | null>;
  workspace?:    () => Promise<Workspace>;
  /** The owner's critic model (Models page); the judge uses the critic's model. */
  criticModel?:  (ws?: Workspace) => Promise<string | null>;
  models?:       (channelKey: string | null) => Partial<Record<EditorRole, string>> | null;
  timeoutMs?:    number;
}

/**
 * Spec 059: the pairwise judge. One AgentLoop run as the `checker` role with one terminal tool, on the critic's model;
 * its spend is `editor.probe`. Never throws: a timeout, an error or no verdict is retried once, then `{ ok: false }` —
 * the probe then counts the sample as undecided rather than guessing.
 */
export class LlmPairwiseJudge implements PairwiseJudge {
  constructor(private readonly d: JudgeDeps) {}

  async compare(i: JudgeInput, o: { channelKey: string | null; maxCostUsd: number }): Promise<JudgeResult> {
    const { workspace, defaultModel } = await readModelContext(this.d);
    const criticModel = this.d.criticModel ? await this.d.criticModel(workspace).catch(() => null) : null;
    const model = resolveModel('checker', this.d.env, this.d.models?.(o.channelKey) ?? null, { agentModel: criticModel, defaultModel, workspace });
    const tool = defineTool({
      name: 'submit_comparison',
      description: 'Віддати порівняння двох постів (завершує роботу): better = A, B або same, до 3 причин і до 3 ризиків.',
      kind: 'terminal', roles: ['checker'],
      input: ComparisonInput,
      execute: async (c) => ({ ok: true, ...c }),
    });
    const user = judgeUserPrompt(i);
    let cost = 0;
    let error = 'no verdict';
    for (let attempt = 1; attempt <= 2; attempt++) {
      let res: AgentLoopResult;
      const ctl = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      try {
        res = await Promise.race([
          this.d.loop.run({
            role: 'checker', channelKey: o.channelKey, slotId: null, model, system: JUDGE_SYSTEM, user, tools: [tool],
            cache: false, signal: ctl.signal, maxSteps: JUDGE_MAX_STEPS, maxCostUsd: Math.max(o.maxCostUsd - cost, 0.001),
            usage: { feature: PROBE_FEATURE, shadow: false },
          }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(new Error(`judge timed out after ${this.d.timeoutMs ?? JUDGE_TIMEOUT_MS}ms`)); }, this.d.timeoutMs ?? JUDGE_TIMEOUT_MS); }),
        ]);
      } catch (err: any) {
        error = errText(err);
        continue;
      } finally {
        if (timer) clearTimeout(timer);
      }
      cost += res.totals?.costUsd ?? 0;
      if (res.terminalTool === 'submit_comparison' && res.terminalResult) {
        const parsed = ComparisonInput.safeParse(res.terminalResult);
        if (parsed.success) return { ok: true, verdict: parsed.data, costUsd: cost };
        error = 'invalid verdict';
        continue;
      }
      error = `${res.status}${res.error ? `: ${res.error}` : ''}`;
      if (res.status === 'budget_exceeded' || res.status === 'disabled') break;
    }
    return { ok: false, error: error.slice(0, 300), costUsd: cost };
  }
}
