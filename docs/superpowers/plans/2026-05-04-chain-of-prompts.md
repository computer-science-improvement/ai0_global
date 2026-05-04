# Chain-of-Prompts Pivot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the orchestrator-driven pipeline in `PostGenerationAgent.generate()`
with an explicit chain of `query()` calls, eliminating recursive subagent dispatch and
making the sequence deterministic in TypeScript code.

**Architecture:** Each subagent (`skill-planner`, `info-preparator`, `post-writer`,
`grammar-reviewer`, `tag-generator`) runs as the primary agent of its own `query()` with
`allowedTools` excluding `Agent` so it cannot dispatch others. `runSubagent` is the shared
helper that runs one query, counts `Skill` calls, and returns a structured result.

**Tech Stack:** NestJS 10, TypeScript 5, `@anthropic-ai/claude-agent-sdk@0.2.119`, Winston.

**Spec:** `docs/superpowers/specs/2026-05-04-chain-of-prompts-pivot.md`

---

## File map

**Modified:**
- `apps/automation/src/common/ai/post-generation.agent.ts` — major refactor:
  - Add `SubagentRunResult` interface and `runSubagent` private method.
  - Rewrite `generate()` as a sequential chain (planner → preparator? → writer → reviewer → cleanup → tag).
  - Update `runTagGenerator` to use the new `runSubagent` helper (no functional change).
  - Refactor `traceSubagents` to a per-query Skill counter (no Agent attribution needed).
  - Remove `RunCapture`, `parseResult`, `tryParseJson`, in-class `stripPreambles` (legacy fallback gone).
  - Update `logRunSummary` to log per-step events.

**Deleted:**
- `apps/automation/.claude/agents/main-news-agent.md`
- `apps/automation/.claude/agents/main-simple-agent.md`

**Unchanged (kept as-is):**
- `apps/automation/src/common/ai/post-generation.helpers.ts` (all 4 exports)
- `apps/automation/src/common/ai/post-generation.helpers.test.ts` (all 22 tests)
- `apps/automation/.claude/agents/skill-planner.md`
- `apps/automation/.claude/agents/info-preparator.md`
- `apps/automation/.claude/agents/post-writer.md`
- `apps/automation/.claude/agents/grammar-reviewer.md`
- `apps/automation/.claude/agents/tag-generator.md`
- `apps/automation/.claude/agents/topic-router.md`, `topic-novelty-checker.md`
- All `.claude/skills/*/SKILL.md`
- `apps/automation/src/common/ai/post-generation.helpers.test.ts`
- Strategies (ai0-news, ua-news) — call signature of `generate(input)` unchanged.

---

## Task 1: Delete orchestrator agent files

**Files:**
- Delete: `apps/automation/.claude/agents/main-news-agent.md`
- Delete: `apps/automation/.claude/agents/main-simple-agent.md`

- [ ] **Step 1: Delete the two orchestrator agent files**

```bash
rm apps/automation/.claude/agents/main-news-agent.md
rm apps/automation/.claude/agents/main-simple-agent.md
```

- [ ] **Step 2: Confirm no other files reference them**

Run from repo root:
```bash
grep -rn "main-news-agent\|main-simple-agent" apps/automation/.claude/ apps/automation/src/ docs/superpowers/specs/2026-05-04-chain-of-prompts-pivot.md 2>/dev/null
```

Expected: only references in `apps/automation/src/common/ai/post-generation.agent.ts` (which Tasks 3–5 will remove) and inside the Spec doc (historical context, ok to keep). Anything else flag and stop.

- [ ] **Step 3: Commit**

```bash
git add -u apps/automation/.claude/agents/main-news-agent.md \
           apps/automation/.claude/agents/main-simple-agent.md
git commit -m "feat(agents): delete orchestrator agent files

Pivot to chain-of-prompts (see spec
docs/superpowers/specs/2026-05-04-chain-of-prompts-pivot.md). Sequence
is now in PostGenerationAgent TypeScript code; no model-driven
orchestration. Subagents run as primary agents of their own query()
with allowedTools=['Skill'] so they cannot dispatch each other.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add `SubagentRunResult` interface + `runSubagent` helper

**Files:**
- Modify: `apps/automation/src/common/ai/post-generation.agent.ts`

- [ ] **Step 1: Add `SubagentRunResult` interface**

In `apps/automation/src/common/ai/post-generation.agent.ts`, near the top (after the existing `GeneratedPost` interface, replacing the `RunCapture` interface — `RunCapture` is removed entirely):

```ts
interface SubagentRunResult {
  /** Final text from the subagent's `result.subtype === 'success'` message. */
  text:        string | null;
  /** Number of `Skill` tool_use blocks emitted during the run. */
  skillCalls:  number;
  /** Per-skill name list (deduped, in invocation order) for telemetry/debug. */
  skillNames:  string[];
  /** SDK-reported turn count. */
  turns:       number;
  /** Total cost reported by the SDK. */
  costUsd:     number;
  /** Wall time in ms. */
  durationMs:  number;
  /** Error message if the SDK threw or returned non-success. */
  error:       string | null;
}
```

- [ ] **Step 2: Add `runSubagent` private method**

Place AFTER the existing `generate()` method body but BEFORE `runTagGenerator`. The method runs one `query()` for a single subagent, counts `Skill` calls, and returns the structured result.

```ts
/**
 * Runs a single subagent as the primary agent of its own query() and returns
 * a structured result. Counts `Skill` tool_use blocks during the run for
 * code-side gate verification.
 *
 * Each step in `generate()` calls this. allowedTools excludes 'Agent' so
 * subagents cannot dispatch other subagents — eliminating the orchestrator-
 * recursion class of bugs that the chain-of-prompts pivot addresses.
 */
private async runSubagent(args: {
  agent:        string;
  prompt:       string;
  allowedTools: string[];
  maxTurns?:    number;
}): Promise<SubagentRunResult> {
  const start = Date.now();
  const skillNames: string[] = [];
  const seenSkillNames = new Set<string>();
  let text: string | null = null;
  let turns = 0;
  let costUsd = 0;

  try {
    for await (const msg of query({
      prompt: args.prompt,
      options: {
        cwd:                             this.cwd,
        settingSources:                  ['project'],
        agent:                           args.agent,
        permissionMode:                  'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns:                        args.maxTurns ?? 10,
        allowedTools:                    args.allowedTools,
      },
    })) {
      if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block?.type !== 'tool_use') continue;
          if (block.name === 'Skill') {
            const skillName: string =
              block.input?.skill ??
              block.input?.name ??
              (typeof block.input === 'string' ? block.input : null) ??
              'unknown';
            if (!seenSkillNames.has(skillName)) {
              seenSkillNames.add(skillName);
              skillNames.push(skillName);
            }
            this.logger.debug(`[${args.agent}]   Skill(${skillName}) ← ${args.agent}`);
          }
        }
      }
      if (msg.type === 'result') {
        turns = msg.num_turns ?? 0;
        if (msg.subtype === 'success') {
          text    = msg.result?.trim() ?? null;
          costUsd = msg.total_cost_usd ?? 0;
        }
      }
    }
  } catch (err: any) {
    return {
      text:       null,
      skillCalls: skillNames.length,
      skillNames,
      turns,
      costUsd,
      durationMs: Date.now() - start,
      error:      err.message,
    };
  }

  return {
    text,
    skillCalls: skillNames.length,
    skillNames,
    turns,
    costUsd,
    durationMs: Date.now() - start,
    error:      text === null ? 'no result message' : null,
  };
}
```

- [ ] **Step 3: TypeScript compiles**

```bash
cd apps/automation && npx tsc -p tsconfig.json --noEmit
```

Expected: no errors. (`runSubagent` isn't called anywhere yet — it's pure addition.)

- [ ] **Step 4: Commit**

```bash
git add apps/automation/src/common/ai/post-generation.agent.ts
git commit -m "feat(ai): add runSubagent helper for chain-of-prompts

Single shared wrapper around query() that runs a subagent as the
primary agent. Counts Skill tool_use blocks for per-step skill-gate
verification. Not yet wired — generate() refactor follows.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Rewrite `generate()` as explicit chain

**Files:**
- Modify: `apps/automation/src/common/ai/post-generation.agent.ts`

This is the central change. Replace the entire body of `generate()` with the chain. Also import `cleanFinalText` (already imported per Task 6 of prior plan — verify).

- [ ] **Step 1: Add a small private helper `parsePlannerJson`**

Place near `runSubagent`:

```ts
/**
 * Parses skill-planner's JSON output. Tolerates wrapping ```json fences
 * and trailing prose. Returns null if shape is wrong or required arrays
 * are missing.
 */
private parsePlannerJson(raw: string): { writerSkills: string[]; reviewerSkills: string[]; notes?: string } | null {
  const trimmed = raw.trim();
  const candidates = [
    trimmed,
    trimmed.match(/```json\s*\n([\s\S]+?)\n```/i)?.[1],
    trimmed.match(/```\s*\n([\s\S]+?)\n```/i)?.[1],
    trimmed.match(/\{[\s\S]*"writerSkills"[\s\S]*\}/)?.[0],
  ].filter((s): s is string => typeof s === 'string' && s.trim().startsWith('{'));

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (Array.isArray(obj?.writerSkills) && Array.isArray(obj?.reviewerSkills)) {
        return {
          writerSkills:   obj.writerSkills.filter((s: any) => typeof s === 'string'),
          reviewerSkills: obj.reviewerSkills.filter((s: any) => typeof s === 'string'),
          notes:          typeof obj.notes === 'string' ? obj.notes : undefined,
        };
      }
    } catch { /* try next candidate */ }
  }
  return null;
}
```

- [ ] **Step 2: Replace the `generate()` body with the chain**

```ts
async generate(input: GenerateInput): Promise<GeneratedPost | 'SKIP_POST' | null> {
  const start = Date.now();
  const summary: PerStepSummary = {
    planner: null, preparator: null, writer: null, reviewer: null, tag: null,
  };

  // Step 1: Plan
  const planRun = await this.runSubagent({
    agent:        'skill-planner',
    prompt:       JSON.stringify({ channelSkill: input.channelSkill, mode: input.mode, rawData: input.rawData }),
    allowedTools: ['Skill'],
    maxTurns:     5,
  });
  summary.planner = planRun;
  if (!planRun.text) {
    return this.failChain('planner returned no text', start, summary);
  }
  if (planRun.skillCalls < 1) {
    return this.failChain(`planner skipped Skill (loaded ${planRun.skillCalls})`, start, summary);
  }
  const plan = this.parsePlannerJson(planRun.text);
  if (!plan) {
    return this.failChain('planner output not parseable', start, summary);
  }

  // Step 2: Enrich (conditional)
  let brief: string;
  const isThin =
    !input.rawData ||
    JSON.stringify(input.rawData).length < 800;
  if (input.mode === 'news' && (input.needsEnrichment || isThin)) {
    const prepRun = await this.runSubagent({
      agent:        'info-preparator',
      prompt:       JSON.stringify(input.rawData),
      allowedTools: ['WebFetch', 'WebSearch'],
      maxTurns:     8,
    });
    summary.preparator = prepRun;
    if (!prepRun.text) {
      return this.failChain('info-preparator returned no text', start, summary);
    }
    brief = prepRun.text;
  } else {
    brief = JSON.stringify(input.rawData);
  }

  // Step 3: Draft
  const writerRun = await this.runSubagent({
    agent:        'post-writer',
    prompt:       JSON.stringify({ skills: plan.writerSkills, brief, channelSkill: input.channelSkill }),
    allowedTools: ['Skill'],
    maxTurns:     10,
  });
  summary.writer = writerRun;
  if (!writerRun.text) {
    return this.failChain('post-writer returned no text', start, summary);
  }
  if (writerRun.text.trim() === 'SKIP_POST') {
    this.logRunSummary({ status: 'skipped', start, summary, reason: 'post-writer SKIP_POST' });
    return 'SKIP_POST';
  }
  if (writerRun.skillCalls < plan.writerSkills.length) {
    return this.failChain(
      `post-writer loaded ${writerRun.skillCalls}/${plan.writerSkills.length} skills`,
      start, summary,
    );
  }

  // Step 4: Review
  const reviewerRun = await this.runSubagent({
    agent:        'grammar-reviewer',
    prompt:       JSON.stringify({ skills: plan.reviewerSkills, draft: writerRun.text }),
    allowedTools: ['Skill'],
    maxTurns:     10,
  });
  summary.reviewer = reviewerRun;
  if (!reviewerRun.text) {
    return this.failChain('grammar-reviewer returned no text', start, summary);
  }
  if (reviewerRun.text.trim() === 'SKIP_POST') {
    this.logRunSummary({ status: 'skipped', start, summary, reason: 'grammar-reviewer SKIP_POST' });
    return 'SKIP_POST';
  }
  if (reviewerRun.skillCalls < plan.reviewerSkills.length) {
    return this.failChain(
      `grammar-reviewer loaded ${reviewerRun.skillCalls}/${plan.reviewerSkills.length} skills`,
      start, summary,
    );
  }

  // Step 5: Clean + length guard
  const cleaned = cleanFinalText(reviewerRun.text);
  const MIN_BODY_CHARS = 80;
  if (cleaned.replace(/<[^>]+>/g, '').trim().length < MIN_BODY_CHARS) {
    return this.failChain(`length guard failed (${cleaned.length} chars)`, start, summary);
  }

  // Step 6: Tag
  const tag = await this.runTagGenerator(cleaned, input.channelSkill);
  summary.tag = { /* fill below in task 4 update */ } as any;

  this.logRunSummary({ status: 'success', start, summary, cleaned, tag });
  return { text: cleaned, tag };
}

/** Per-step summary type used by logRunSummary. */
interface PerStepSummary {
  planner:    SubagentRunResult | null;
  preparator: SubagentRunResult | null;
  writer:     SubagentRunResult | null;
  reviewer:   SubagentRunResult | null;
  tag:        SubagentRunResult | null;
}

/** Common failure path: log + return null. */
private failChain(reason: string, start: number, summary: PerStepSummary): null {
  this.logger.warn(`[chain] ${reason}`);
  this.logRunSummary({ status: 'error', start, summary, reason });
  return null;
}
```

(Note: `PerStepSummary` is declared inside the file scope or as a private type. The `logRunSummary` signature changes — Task 5 updates it.)

- [ ] **Step 3: Remove `RunCapture` interface and `traceSubagents` method**

Both are now unused — `runSubagent` does the per-query Skill counting inline. Find and DELETE:
- The `interface RunCapture { ... }` block (added in prior Task 5).
- The `private traceSubagents(...)` method body (was modified in prior Task 5).

The existing `traceSubagents` debug log format is preserved by the `runSubagent` helper's own debug log (`[${args.agent}]   Skill(${skillName}) ← ${args.agent}`).

- [ ] **Step 4: Remove legacy `parseResult`, in-class `stripPreambles`, `tryParseJson`**

Find and DELETE these private methods (no longer called from anywhere):
- `private parseResult(raw: string): GeneratedPost`
- `private stripPreambles(raw: string): string`
- `private tryParseJson(input: string): GeneratedPost | null`

Their JSDoc `@deprecated` notes go with them.

- [ ] **Step 5: Update existing imports**

Verify the top of the file imports:
```ts
import { cleanFinalText } from './post-generation.helpers';
```
(was added in prior Task 6.) Other imports stay. Remove unused imports if any after deletions.

- [ ] **Step 6: TypeScript compiles**

```bash
cd apps/automation && npx tsc -p tsconfig.json --noEmit
```

Expected: clean. If errors mention `RunCapture`, `parseResult`, `traceSubagents`, you missed a reference somewhere — find and fix.

- [ ] **Step 7: Helper tests still pass**

```bash
npx tsx --test apps/automation/src/common/ai/post-generation.helpers.test.ts
```

Expected: `# pass 22`, `# fail 0`. (Helpers are unchanged.)

- [ ] **Step 8: Commit**

```bash
git add apps/automation/src/common/ai/post-generation.agent.ts
git commit -m "refactor(ai): generate() runs explicit chain of subagents

Replaces orchestrator-driven dispatch with a sequential chain of
runSubagent() calls: skill-planner → info-preparator (conditional) →
post-writer → grammar-reviewer → cleanFinalText → tag-generator. Each
subagent runs as its own query() primary agent with allowedTools that
excludes 'Agent', so subagents physically cannot dispatch others.

Removes:
- RunCapture interface and cross-subagent traceSubagents tracking
- parseResult, in-class stripPreambles, tryParseJson legacy fallback
  methods (no orchestrator output to parse)

Per-step skill-gate replaces the cross-subagent gate: each step
verifies skillCalls >= expected, where expected for writer/reviewer
comes from skill-planner's output.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Migrate `runTagGenerator` to `runSubagent`

**Files:**
- Modify: `apps/automation/src/common/ai/post-generation.agent.ts`

`runTagGenerator` was added in prior Task 7 with its own inline `query()` loop. The new `runSubagent` helper does the same job. Refactor for DRY.

- [ ] **Step 1: Replace `runTagGenerator` body with a call to `runSubagent`**

```ts
private async runTagGenerator(post: string, channelSkill: string): Promise<string> {
  const result = await this.runSubagent({
    agent:        'tag-generator',
    prompt:       JSON.stringify({ channelSkill, post }),
    allowedTools: ['Skill'],
    maxTurns:     3,
  });
  if (result.error) {
    this.logger.warn(`tag-generator failed: ${result.error}`);
    return '';
  }
  if (result.skillCalls === 0) {
    this.logger.warn('tag-generator did not invoke Skill — discarding tag');
    return '';
  }
  return this.cleanTag(result.text ?? '');
}
```

The `runTagGenerator` keeps its public signature (used by `generate()`). It now also returns the `SubagentRunResult` indirectly via the per-step summary (caller gets the cleaned tag string; the summary is updated separately).

- [ ] **Step 2: Update the `summary.tag` assignment in `generate()`**

In Task 3's `generate()` body, the `summary.tag = { ... } as any` placeholder needs to be replaced with the actual `SubagentRunResult` from a slightly modified `runTagGenerator` that also returns the result.

**Cleaner refactor:** make `runTagGenerator` return `{ tag: string; result: SubagentRunResult }` and adjust the call site:

```ts
// At call site in generate():
const tagOutcome = await this.runTagGenerator(cleaned, input.channelSkill);
summary.tag = tagOutcome.result;
const tag = tagOutcome.tag;

// runTagGenerator becomes:
private async runTagGenerator(post: string, channelSkill: string): Promise<{ tag: string; result: SubagentRunResult }> {
  const result = await this.runSubagent({
    agent:        'tag-generator',
    prompt:       JSON.stringify({ channelSkill, post }),
    allowedTools: ['Skill'],
    maxTurns:     3,
  });
  let tag = '';
  if (!result.error && result.skillCalls > 0 && result.text) {
    tag = this.cleanTag(result.text);
  } else if (result.error) {
    this.logger.warn(`tag-generator failed: ${result.error}`);
  } else if (result.skillCalls === 0) {
    this.logger.warn('tag-generator did not invoke Skill — discarding tag');
  }
  return { tag, result };
}
```

- [ ] **Step 3: TypeScript compiles**

```bash
cd apps/automation && npx tsc -p tsconfig.json --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/automation/src/common/ai/post-generation.agent.ts
git commit -m "refactor(ai): runTagGenerator uses shared runSubagent

Removes duplicate inline query() loop. Returns both the tag string
and the underlying SubagentRunResult so the per-step summary in
generate() can include the tag step's metrics.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Update `logRunSummary` for per-step events

**Files:**
- Modify: `apps/automation/src/common/ai/post-generation.agent.ts`

The current `logRunSummary` (added in prior Task 8) is shaped around the orchestrator design. Update it to the per-step shape from the spec.

- [ ] **Step 1: Replace `logRunSummary` signature and body**

```ts
private logRunSummary(args: {
  status:  'success' | 'error' | 'skipped';
  start:   number;                  // Date.now() at generate() entry
  summary: PerStepSummary;
  cleaned?: string;
  tag?:     string;
  reason?:  string;
}): void {
  const durationMs = Date.now() - args.start;

  const stepDigest = (r: SubagentRunResult | null) => r ? {
    skillCalls: r.skillCalls,
    skillNames: r.skillNames,
    turns:      r.turns,
    costUsd:    r.costUsd,
    durationMs: r.durationMs,
    ok:         r.error === null,
    error:      r.error,
  } : null;

  this.structured.log({
    category: 'ai_response',
    level:    args.status === 'error' ? 'error' : 'info',
    message:  `PostGenerationAgent/agent-sdk-chain ← ${args.status} (${durationMs}ms)`,
    data: {
      agent:       'PostGenerationAgent',
      model:       'agent-sdk-chain',
      status:      args.status,
      durationMs,
      steps: {
        planner:    stepDigest(args.summary.planner),
        preparator: stepDigest(args.summary.preparator),
        writer:     stepDigest(args.summary.writer),
        reviewer:   stepDigest(args.summary.reviewer),
        tag:        stepDigest(args.summary.tag),
      },
      finalLength: args.cleaned?.length ?? 0,
      tagWord:     args.tag ?? '',
      error:       args.status === 'error' ? args.reason ?? null : null,
      reason:      args.reason ?? null,    // for skipped/error context
    },
  });
}
```

- [ ] **Step 2: Update all call sites in `generate()`**

The chain in Task 3 already uses `logRunSummary({ status, start, summary, ... })`. Confirm all 7 logically reachable exit paths have their call. There should be:
- planner null/no-skill/unparseable → `failChain` → log
- preparator null → `failChain` → log
- writer null/SKIP_POST/skill-short → `failChain` for null/short, direct log for SKIP_POST
- reviewer null/SKIP_POST/skill-short → same
- length guard fail → `failChain` → log
- success → log

(These are all in Task 3's body; verify nothing slipped through.)

- [ ] **Step 3: TypeScript compiles**

```bash
cd apps/automation && npx tsc -p tsconfig.json --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/automation/src/common/ai/post-generation.agent.ts
git commit -m "feat(ai): logRunSummary records per-step events

Each step (planner/preparator/writer/reviewer/tag) emits its own
digest with skillCalls, skillNames, turns, cost, duration, and ok
flag. /analyze can now surface per-step success rates and skill-count
violations per stage.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Type-check, run helper tests, smoke

**Files:** none (verification only)

- [ ] **Step 1: Full TypeScript check**

```bash
cd apps/automation && npx tsc -p tsconfig.json --noEmit
```

Expected: no errors.

- [ ] **Step 2: Run helper tests**

```bash
npx tsx --test apps/automation/src/common/ai/post-generation.helpers.test.ts
```

Expected: `# pass 22`, `# fail 0`.

- [ ] **Step 3: Smoke run — news mode**

The user runs the dev server and triggers ai0-news (cron fires every 5 minutes, or via admin `/run`). Capture stdout. Look for:

```
[skill-planner]   Skill(channel-ai0-news) ← skill-planner
[post-writer]   Skill(human-voice) ← post-writer
[post-writer]   Skill(anti-slop) ← post-writer
[post-writer]   Skill(channel-ai0-news) ← post-writer
[grammar-reviewer]   Skill(grammar-ua) ← grammar-reviewer
[grammar-reviewer]   Skill(anti-slop) ← grammar-reviewer
[grammar-reviewer]   Skill(channel-ai0-news) ← grammar-reviewer
[tag-generator]   Skill(channel-ai0-news) ← tag-generator
```

**Critical absence:** No `→ main-news-agent` or `→ main-simple-agent` lines (those agents are deleted). No recursive dispatches.

- [ ] **Step 4: Telegram check**

@ai0_global post produced during step 3 must:
- Not start with "Ось готовий пост:", "Готовий пост:", "Пост:", etc.
- Not contain `**bold**` markdown.
- Not contain `---` separators.
- Render bold/italic via Telegram HTML (`<b>`, `<i>`).

- [ ] **Step 5: Smoke run — ua-news / simple mode**

Trigger ua-news (and any simple-mode strategy already migrated). Verify the same skill-load trace and clean Telegram output.

- [ ] **Step 6: Skip-path check (optional)**

Temporarily rename `apps/automation/.claude/skills/grammar-ua/SKILL.md` to `.bak`, trigger ua-news, expect:
- `[chain] grammar-reviewer loaded N/M skills` warn (or grammar-reviewer returns SKIP_POST per Task 12 of prior plan)
- structured log with `status: 'error'` or `status: 'skipped'`
- No Telegram publish for that item

Restore the file when done.

- [ ] **Step 7: No code commit needed for this task** (verification-only). If smoke surfaces a real bug, fix it under a separate `fix(ai):` commit on this branch.

---

## Task 7: Final review + finishing the branch

**Files:** none

- [ ] **Step 1: Dispatch a final code-quality review** for the entire branch (since baseline checkpoint `6dcdb88`).

- [ ] **Step 2: Fix any blocking issues raised**.

- [ ] **Step 3: Use the superpowers:finishing-a-development-branch skill** to decide between merge / PR / cleanup.
