import type { Pool } from 'pg';
import type { PostSpec } from '../../src/editor/post/post-spec';
import type { EditorRole } from '../../src/editor/llm/llm.types';
import { htmlToPlain } from '../../src/editor/post/inline-markup';
import type { EvalStack } from './stack';
import type { FakeWeb } from './fake-web';
import type { Check } from './graders';
import type { JudgeInput } from './judge';
import { runningSlot } from './seed';
import { stepsOf, toolErrors } from './graders';

export interface CaseCtx {
  pool:  Pool;
  now:   Date;
  web:   FakeWeb;
  stack: EvalStack;
}

export interface CaseOutcome {
  runId:         string | null;
  status:        string;
  terminalTool?: string;
  checks:        Check[];
  /** What the judge should look at (executor cases that produced a post). */
  judge?:        JudgeInput;
  post?:         string;
  toolErrors?:   string[];
  toolsUsed?:    string[];
}

export interface EvalCase {
  id:          string;
  role:        EditorRole;
  title:       string;
  channel:     string;
  /** Fixture web for this case. */
  web():       FakeWeb;
  execute(ctx: CaseCtx): Promise<CaseOutcome>;
}

/** Shared executor flow: create a running slot, run the real executor, collect spec + trace. */
export async function runExecutor(ctx: CaseCtx, channel: string, slot: { format: string; topic: string; angle?: string; hints?: string[] }) {
  const card = (await ctx.stack.channels.get(channel))!;
  const s = await runningSlot(ctx.pool, channel, ctx.now, slot);
  const res = await ctx.stack.runner.runExecutor(s, card);
  const after = (await ctx.stack.plans.getSlot(s.id))!;
  const steps = await stepsOf(ctx.pool, res.runId);
  const spec = (after.postSpec ?? null) as PostSpec | null;
  const post = after.renderedPreview ? htmlToPlain(after.renderedPreview) : '';
  return {
    card, res, after, spec, post, steps,
    toolErrors: toolErrors(steps),
    toolsUsed: steps.filter((x) => x.type === 'tool').map((x) => x.tool_name ?? '?'),
  };
}
