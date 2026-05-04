# Pivot to Chain-of-Prompts — Design Addendum

**Supersedes:** the orchestrator-with-stream-capture architecture from
`2026-05-01-subagent-skill-gate-design.md`. The pure helpers, subagent prompt updates
(Step 0 mandatory skill loading, fail-closed grammar-reviewer), and the separate
tag-generator query from that spec are kept as-is. The orchestrator-driven
architecture is replaced.

## Why we are pivoting

Two rounds of smoke testing on `feat/subagent-skill-gate` revealed that the
orchestrator-driven pipeline is fundamentally unreliable in `@anthropic-ai/claude-agent-sdk@0.2.119`:

**Round 1 evidence (commit `9929906`):**
```
Skill(channel-ai0-news) ← subagent       # owner = literal 'subagent' fallback
[skill-gate] skill-planner loaded 0 skills, expected >= 1
```
Root cause: SDK calls the dispatch tool `Agent`, not `Task`. We were checking
`block.name === 'Task'` which never matched, so `pendingTasks` map stayed empty and
`parent_tool_use_id` couldn't be resolved.

**Round 2 evidence (commit `a024d3d`, after Task→Agent fix):**
```
[main-news-agent] → main-news-agent (KSzn5PXB)        ← recursive self-dispatch
[main-news-agent] → main-simple-agent (gAiPBnbc)      ← sibling orchestrator
[main-news-agent] → tag-generator (H32Aw3tg)
[main-news-agent]   Skill(channel-ai0-news) ← tag-generator
```
The orchestrator dispatches itself recursively and its sibling — but never
`skill-planner`, `post-writer`, or `grammar-reviewer`. The recursive
`main-news-agent` returned 7543 chars in 40s, presumably writing the post
directly without delegating either.

**Why this happens:** The SDK auto-discovers all agents in `.claude/agents/` and
exposes them as valid `subagent_type` values for the Agent tool. The model sees
the description "Orchestrates Ukrainian news post generation..." on `main-news-agent`
and decides to dispatch that — even when it IS `main-news-agent`. The
"Subagents available via Task" section in the prompt is **descriptive**, not
**enforced** — the SDK exposes the full list regardless.

`allowedTools` only restricts tool NAMES (Skill/Agent/Read/etc.), not which
`subagent_type` values are acceptable for the Agent tool. There is no SDK
mechanism to restrict subagent dispatch to a whitelist.

**Conclusion:** Orchestrator-pattern is brittle. Even strong prompts fail because
the model trusts the SDK's discovery list over the prompt's restrictions. The fix
is not more prompt engineering — it is to take orchestration out of the model's
hands.

## New architecture: explicit chain-of-prompts

`PostGenerationAgent.generate()` becomes a sequential async chain of `query()` calls.
Each step runs a single subagent as the **primary agent** (via the `agent:` query
option). No subagent ever dispatches another. No recursion is possible.

```
strategy
  ↓
PostGenerationAgent.generate({ mode, channelSkill, rawData, needsEnrichment })
  ↓
  ┌──────────────────────────────────────────────────────────────────────┐
  │  Step 1: query(agent='skill-planner', ['Skill'])                     │
  │    → JSON { writerSkills, reviewerSkills, notes }                    │
  │    fail → null                                                       │
  ├──────────────────────────────────────────────────────────────────────┤
  │  Step 2 (news mode + thin content): query(agent='info-preparator',   │
  │    ['WebFetch', 'WebSearch'])                                        │
  │    → structured brief (plain text)                                   │
  │    fail → null  (skip → use rawData as brief)                        │
  ├──────────────────────────────────────────────────────────────────────┤
  │  Step 3: query(agent='post-writer', ['Skill'])                       │
  │    input: { skills: writerSkills, brief, channelSkill }              │
  │    → draft text                                                      │
  │    SKIP_POST → return 'SKIP_POST'                                    │
  │    skill calls < writerSkills.length → null                          │
  ├──────────────────────────────────────────────────────────────────────┤
  │  Step 4: query(agent='grammar-reviewer', ['Skill'])                  │
  │    input: { skills: reviewerSkills, draft }                          │
  │    → cleaned text                                                    │
  │    SKIP_POST → return 'SKIP_POST'                                    │
  │    skill calls < reviewerSkills.length → null                        │
  ├──────────────────────────────────────────────────────────────────────┤
  │  Step 5: cleanFinalText + length guard                               │
  ├──────────────────────────────────────────────────────────────────────┤
  │  Step 6: query(agent='tag-generator', ['Skill'])                     │
  │    input: { post: cleaned, channelSkill }                            │
  │    → single word                                                     │
  │    soft-fail → empty tag                                             │
  └──────────────────────────────────────────────────────────────────────┘
  ↓
  return { text: cleaned, tag } | 'SKIP_POST' | null
```

### Properties

- **Deterministic.** The sequence is in TS code, not in a model prompt.
- **No recursive dispatch possible.** Each query has `allowedTools` that excludes
  `Agent`. Subagents physically cannot invoke each other.
- **Per-step skill verification.** We count `Skill` tool_use blocks within each
  query. For `post-writer` and `grammar-reviewer`, we know the EXACT number of
  skills the planner asked for, so we can require an exact match.
- **Per-step error attribution.** If a step fails, we know which step failed and
  can tell the strategy directly.
- **Smaller per-query context.** Each subagent only sees its specific input —
  no orchestrator history, no cross-subagent leakage. Lower token cost per query.
- **Cleaner telemetry.** Per-step events with explicit step name.

## What is kept from the prior spec

- `apps/automation/src/common/ai/post-generation.helpers.ts` —
  `stripStrayMarkdown`, `stripPreambles`, `cleanFinalText`, `skillGatePassed`,
  `SkillGateResult`. All 22 unit tests stay green.
  - `skillGatePassed` is no longer the primary gate but stays as a reusable
    utility — TBD whether per-step `skillCallsOk` replaces it entirely.
- `apps/automation/src/common/ai/post-generation.helpers.test.ts` — all 22 tests.
- `apps/automation/.claude/agents/skill-planner.md` — Step 0 mandatory channel-skill
  load. Output contract (JSON `{writerSkills, reviewerSkills, notes}`) unchanged.
- `apps/automation/.claude/agents/info-preparator.md` — unchanged from baseline.
- `apps/automation/.claude/agents/post-writer.md` — Step 0 + drafting rules.
  Loaded by post-writer query.
- `apps/automation/.claude/agents/grammar-reviewer.md` — Step 0 fail-closed.
- `apps/automation/.claude/agents/tag-generator.md` — Step 0.
- `runTagGenerator` in `PostGenerationAgent` (Task 7 from prior plan) —
  was already a separate `query()`; the chain pattern now matches.
- Telemetry hook `logRunSummary` (Task 8 from prior plan) — extended to log
  per-step events instead of one big run summary.
- `tsx` test runner setup (Task 1 from prior plan).

## What is removed

- `apps/automation/.claude/agents/main-news-agent.md` — orchestrator no longer
  needed. Delete.
- `apps/automation/.claude/agents/main-simple-agent.md` — orchestrator no longer
  needed. Delete.
- `RunCapture` interface and the cross-subagent `traceSubagents` complexity
  (Tasks 5 from prior plan) — no longer needed because there is no orchestrator
  to trace. Replaced by a per-query `Skill` counter.
- `parseResult`, in-class `stripPreambles`, `tryParseJson` legacy fallback methods
  on `PostGenerationAgent` — orchestrator output no longer exists, so no fallback
  to write. Delete.
- The cross-subagent `skillGatePassed(used: Map<string, Set<string>>)` consumer in
  `generate()` — replaced by per-query `Skill`-call count check. (The helper itself
  stays as a utility for now; can be deleted later.)

## New components

### `runSubagent` helper (private method on `PostGenerationAgent`)

```ts
interface SubagentRunResult {
  /** Final text from the subagent's `result.subtype === 'success'` message. */
  text:        string | null;
  /** Number of `Skill` tool_use blocks emitted during the run. */
  skillCalls:  number;
  /** Per-skill name → count, for telemetry. */
  skillNames:  string[];
  /** SDK-reported turn count for this run. */
  turns:       number;
  /** Total cost reported by the SDK. */
  costUsd:     number;
  /** Wall time. */
  durationMs:  number;
  /** Error message if the SDK threw or returned non-success. */
  error:       string | null;
}

private async runSubagent(args: {
  agent:        string;                     // subagent name (e.g. 'post-writer')
  prompt:       string;                     // already JSON-stringified or plain
  allowedTools: string[];                   // exact tool whitelist for this run
  maxTurns?:    number;                     // default 10
}): Promise<SubagentRunResult>
```

Single shared implementation. Each step in `generate()` calls `runSubagent` with
its own `agent`, `prompt`, and `allowedTools`. The function counts `Skill` calls
during the loop, logs the standard `[agent] Skill(...) ← agent` line, and
returns the structured result. No `Agent` tool tracking needed because subagents
have `allowedTools: ['Skill']` (or similar narrow set) — they physically cannot
dispatch other subagents.

### Per-step skill count check

For `post-writer` and `grammar-reviewer`, we know the planner's expected skill list:

```ts
if (writerResult.skillCalls < writerSkills.length) {
  this.logger.warn(`post-writer loaded ${writerResult.skillCalls} skills, expected ${writerSkills.length}`);
  return null;
}
```

Tighter than the prior `>= 2` heuristic. Plus we have visibility into WHICH
skills were missed (compare `writerResult.skillNames` vs `writerSkills`).

### `generate()` shape

```ts
async generate(input: GenerateInput): Promise<GeneratedPost | 'SKIP_POST' | null> {
  const start = Date.now();

  // 1. Plan
  const planResult = await this.runSubagent({
    agent:        'skill-planner',
    prompt:       JSON.stringify({ channelSkill: input.channelSkill, mode: input.mode, rawData: input.rawData }),
    allowedTools: ['Skill'],
    maxTurns:     5,
  });
  if (!planResult.text || planResult.skillCalls < 1) {
    this.logRunSummary({ ..., status: 'error', error: 'planner failed or skipped Skill' });
    return null;
  }
  const plan = this.parsePlannerJson(planResult.text);
  if (!plan) {
    this.logRunSummary({ ..., status: 'error', error: 'planner output not parseable' });
    return null;
  }

  // 2. Enrich (conditional)
  let brief: string;
  if (input.mode === 'news' && (input.needsEnrichment || isThin(input.rawData))) {
    const prepResult = await this.runSubagent({
      agent:        'info-preparator',
      prompt:       JSON.stringify(input.rawData),
      allowedTools: ['WebFetch', 'WebSearch'],
      maxTurns:     8,
    });
    if (!prepResult.text) {
      this.logRunSummary({ ..., status: 'error', error: 'info-preparator failed' });
      return null;
    }
    brief = prepResult.text;
  } else {
    brief = JSON.stringify(input.rawData);
  }

  // 3. Draft
  const draftResult = await this.runSubagent({
    agent:        'post-writer',
    prompt:       JSON.stringify({ skills: plan.writerSkills, brief, channelSkill: input.channelSkill }),
    allowedTools: ['Skill'],
    maxTurns:     10,
  });
  if (!draftResult.text) {
    this.logRunSummary({ ..., status: 'error', error: 'post-writer failed' });
    return null;
  }
  if (draftResult.text.trim() === 'SKIP_POST') return 'SKIP_POST';
  if (draftResult.skillCalls < plan.writerSkills.length) {
    this.logRunSummary({ ..., status: 'error', error: `writer loaded ${draftResult.skillCalls}/${plan.writerSkills.length} skills` });
    return null;
  }

  // 4. Review
  const reviewResult = await this.runSubagent({
    agent:        'grammar-reviewer',
    prompt:       JSON.stringify({ skills: plan.reviewerSkills, draft: draftResult.text }),
    allowedTools: ['Skill'],
    maxTurns:     10,
  });
  if (!reviewResult.text) {
    this.logRunSummary({ ..., status: 'error', error: 'grammar-reviewer failed' });
    return null;
  }
  if (reviewResult.text.trim() === 'SKIP_POST') return 'SKIP_POST';
  if (reviewResult.skillCalls < plan.reviewerSkills.length) {
    this.logRunSummary({ ..., status: 'error', error: `reviewer loaded ${reviewResult.skillCalls}/${plan.reviewerSkills.length} skills` });
    return null;
  }

  // 5. Clean + length guard
  const cleaned = cleanFinalText(reviewResult.text);
  if (failsLengthGuard(cleaned)) {
    this.logRunSummary({ ..., status: 'error', error: 'length guard failed' });
    return null;
  }

  // 6. Tag (existing runTagGenerator)
  const tag = await this.runTagGenerator(cleaned, input.channelSkill);

  this.logRunSummary({ ..., status: 'success', cleaned, tag });
  return { text: cleaned, tag };
}
```

## Cost & latency comparison

| Metric | Orchestrator (current) | Chain (new) |
|---|---|---|
| Top-level `query()` calls | 1 + 1 (tag) | 4-5 + 1 (tag) |
| Total turns observed in smoke | 3 (orchestrator), but with embedded subagent runs | 3-5 per step (skill-planner: 2; preparator: 5-8; writer: 5-8; reviewer: 5-8; tag: 2) |
| Total cost per news run | ~$0.15-$0.25 (smoke evidence) | ~$0.10-$0.20 estimated (smaller per-query contexts → less repeated system prompt cost) |
| Total wall time | ~80s-95s (smoke evidence) | ~40s-70s estimated (no orchestrator overhead, but sequential not parallel) |

Conservative estimate: similar cost, slightly faster, much higher reliability.

## Error handling matrix (chain mode)

| Scenario | Detection | Action |
|---|---|---|
| `runSubagent` SDK throw | catch block | error log + `error: '<msg>'` returned in result; caller treats as failure |
| Subagent returns no result message | post-loop `text === null` | caller logs step name + returns `null` |
| `skill-planner` channel-skill not loaded | `skillCalls < 1` | log + null (retry next cron) |
| `skill-planner` JSON unparseable | `parsePlannerJson` returns null | log + null |
| `info-preparator` returns empty | `text === null` after `.trim()` | log + null |
| `post-writer` returns `SKIP_POST` | exact string match on `.trim()` | return `'SKIP_POST'` (mark dedup, no publish) |
| `post-writer` skill count short | `skillCalls < writerSkills.length` | log + null |
| `grammar-reviewer` returns `SKIP_POST` | exact string match | return `'SKIP_POST'` |
| `grammar-reviewer` skill count short | same as writer | log + null |
| Length guard fail (< 80 chars) | post-clean check | log + null |
| `tag-generator` fail | `runTagGenerator` already soft-fails | empty tag, post still publishes |

## Telemetry

Per-run summary emitted at the end of `generate()`:

```ts
{
  agent: 'PostGenerationAgent',
  model: 'agent-sdk-chain',
  status: 'success' | 'error' | 'skipped',
  durationMs,
  steps: {
    planner:    { skillCalls, costUsd, turns, durationMs, ok },
    preparator: { skillCalls: 0, costUsd, turns, durationMs, ok, ranOrSkipped },
    writer:     { skillCalls, expectedSkills, costUsd, turns, durationMs, ok },
    reviewer:   { skillCalls, expectedSkills, costUsd, turns, durationMs, ok },
    tag:        { skillCalls, tagWord, costUsd, turns, durationMs, ok },
  },
  finalLength: cleaned?.length ?? 0,
  error:       null | string,
}
```

`/analyze` can surface per-step success rates, skill-count violations per stage,
cost per step.

## Verification (chain mode)

1. `cd apps/automation && npx tsc -p tsconfig.json --noEmit` — no errors.
2. All 22 helper tests still pass.
3. Smoke `/run ai0-news`:
   - stdout shows ordered subagent runs:
     ```
     [PostGenerationAgent] step=planner agent=skill-planner ...
     [skill-planner]   Skill(channel-ai0-news) ← skill-planner
     [PostGenerationAgent] step=writer  agent=post-writer ...
     [post-writer]   Skill(human-voice) ← post-writer
     [post-writer]   Skill(anti-slop) ← post-writer
     [post-writer]   Skill(channel-ai0-news) ← post-writer
     [PostGenerationAgent] step=reviewer agent=grammar-reviewer ...
     [grammar-reviewer]   Skill(grammar-ua) ← grammar-reviewer
     [grammar-reviewer]   Skill(anti-slop) ← grammar-reviewer
     [grammar-reviewer]   Skill(channel-ai0-news) ← grammar-reviewer
     [PostGenerationAgent] step=tag agent=tag-generator ...
     [tag-generator]   Skill(channel-ai0-news) ← tag-generator
     ```
   - **No** `→ main-news-agent` (recursive) or `→ main-simple-agent`.
   - Final post in @ai0_global without `**`, without preamble, without `---`.
4. Smoke `/run ua-news`: same shape.
5. Skip-path: paywall stub → grammar-reviewer returns `SKIP_POST` → strategy
   marks dedup.

## Out of scope

- Restoring the orchestrator design under any circumstances.
- Migrating remaining strategies (movies, recipes, etc.) — separate PR.
- Replacing `info-preparator` with non-SDK code (it actually needs WebFetch/WebSearch
  and benefits from being a dedicated subagent run).

## Open questions

None. Architecture is settled; implementation plan follows.
