# Subagent Skill-Gate & Stream-Capture Pipeline — Design

## Context

The recently shipped `PostGenerationAgent` (commit `8e6b45e`) wraps `@anthropic-ai/claude-agent-sdk`
with a 5-step pipeline: `main-(news|simple)-agent` orchestrates `skill-planner` → `info-preparator`
(news only) → `post-writer` → `grammar-reviewer` → `tag-generator`, then must emit a strict JSON
envelope `{"text": "...", "tag": "..."}`.

Production logs (29 main-agent runs across 2026-04-24 and 2026-04-26) show the contract is broken:

| Signal | Count | Implication |
|---|---|---|
| Output starts as JSON `{"text": ...}` | **0/29** | Orchestrator never honours its emit contract |
| Preamble (`Готовий пост:` / `Пост:` / `**Готовий пост:**`) | 7/29 (24%) | `stripPreambles()` runs only on the outer wrapper, leak survives in `text` |
| Markdown `**bold**` in body | 16/29 (55%) | `anti-slop` / channel skills not effectively applied; Telegram parses HTML, so `**` renders literally |
| Emoji in first 300 chars | 8/29 | Channel skills forbid emoji yet they leak |
| Hard errors logged | 0 | All issues are silent quality failures |

`parseResult()` consequently always falls through to "no JSON, no delimiter" branch, returning the
raw markdown blob with empty tag — strategies then publish junk-styled posts and rely on RSS-tag
fallback.

We cannot prove from structured logs whether subagents actually invoke the `Skill` tool (debug
traces go to NestJS console / Docker stdout, not the structured file). The high markdown/emoji
leak rate is consistent with skills not being loaded effectively.

## Goal

Restructure the pipeline so:

1. The final post text is captured from the SDK message stream (the `tool_result` of the last
   `grammar-reviewer` Task), not from the orchestrator's free-text output.
2. The orchestrator emits only a status sentinel: `DONE` or `SKIP_POST`.
3. Tag generation runs as a separate `query()` call against `tag-generator`, isolated from
   orchestrator context.
4. Skill loading becomes contractually verified — subagents must invoke `Skill(...)` for every
   item in their `skills` input array, AND `PostGenerationAgent` audits the message stream to
   confirm skill-tool calls happened. Failure to meet the gate aborts the run.
5. Defensive cleanup (`stripPreambles`, markdown-bold removal) runs against the captured text,
   not the wrapper.

## Non-goals

- Replacing the agent-SDK architecture with linear chain-of-prompts (option C in brainstorming).
- Migrating remaining strategies (movies, recipes, etc.) — already covered by the prior design
  doc; this design is orthogonal and applies once they migrate.
- Changes to `topic-router`, `topic-novelty-checker`, `info-preparator` (no `Skill` tool — not in
  scope).
- Removing `parseResult()` legacy fallback — kept temporarily for rollout safety; deletion is a
  follow-up after a week of monitoring.
- Removing `FormatterService` / `SummarizerService` / `ReviewAgent` — separate cleanup PR.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Strategy (NestJS) — fetch → clean → dedup → resolve image                │
│    ↓                                                                     │
│    PostGenerationAgent.generate({ mode, channelSkill, rawData, … })       │
│      ↓                                                                   │
│      ┌── Run 1: orchestrator ────────────────────────────────────────┐   │
│      │ query({ agent: main-(news|simple)-agent, allowedTools: [...] })│  │
│      │  collects via traceSubagents():                                │  │
│      │    - finalText  ← last grammar-reviewer tool_result text       │  │
│      │    - skillsUsed ← Map<subagentName, Set<skillName>>            │  │
│      │    - statusSignal ← orchestrator's result.result string        │  │
│      └────────────────────────────────────────────────────────────────┘  │
│      ↓                                                                   │
│      cleanFinalText(finalText) — strip preambles, markdown, separators    │
│      length-guard, skill-gate, length-guard                              │
│      ↓                                                                   │
│      ┌── Run 2: tag ──────────────────────────────────────────────────┐  │
│      │ query({ agent: tag-generator, allowedTools: ['Skill'],         │  │
│      │         maxTurns: 3, prompt: { post, channelSkill } })         │  │
│      │  → cleanTag(rawTagWord)                                        │  │
│      └────────────────────────────────────────────────────────────────┘  │
│      ↓                                                                   │
│    return { text: cleanedText, tag } | 'SKIP_POST' | null                 │
└──────────────────────────────────────────────────────────────────────────┘
```

Key shifts vs. current implementation:

- Orchestrator's free-text output is **not** the post text any more.
- Final text is taken from `grammar-reviewer`'s last `tool_result` block in the assistant
  message stream (the `Task` tool result that the orchestrator received).
- Tag is computed in a separate, smaller `query()` run. The current 5th step inside the
  orchestrator is removed.
- Skill-loading is gated both by prompt (Step 0 in each subagent) and by code (count check on
  observed `Skill` tool-uses).

## Component changes

### 1. `apps/automation/.claude/agents/main-news-agent.md`

Sequence sections 1–4 unchanged (skill-planner → info-preparator → post-writer →
grammar-reviewer). Sections 5 (tag) and 6 (JSON output) replaced with:

```
## 5. Final output — STATUS ONLY
After grammar-reviewer returns successfully, output the literal three-letter
string `DONE` and nothing else. Do NOT echo the post text. Do NOT add JSON.
Do NOT add quotes, code fences, or any wrapper.

If any subagent failed along the way, output `SKIP_POST` instead.

## Hard rules
- Never write post prose yourself.
- Never include the post text in your final reply — it is captured from
  grammar-reviewer's tool_result automatically.
- Always run skill-planner → (info-preparator if needed) → post-writer →
  grammar-reviewer in order.
- Final reply is exactly one of: `DONE`, `SKIP_POST`. Nothing else.
```

### 2. `apps/automation/.claude/agents/main-simple-agent.md`

Same shape as main-news-agent (without info-preparator step). Replace "Step 4. Tag" and
"Step 5. JSON output" with the `DONE` / `SKIP_POST` sentinel rules.

### 3. `apps/automation/.claude/agents/post-writer.md`

Add as the **first** section, before any other guidance:

```
## Step 0 — Skill loading (MANDATORY, BEFORE ANYTHING ELSE)
The user message contains a `skills` array, e.g. ["human-voice","anti-slop","channel-X"].

You MUST invoke `Skill(<name>)` for EVERY entry in that array. This is non-negotiable.
Emit one tool call per skill, in any order, before drafting a single character of post text.

If `skills` has 3 entries, you MUST emit 3 `Skill` tool calls.

If any `Skill` call fails or returns an error, your response MUST be the literal string
`SKIP_POST` and nothing else. Do not draft from memory.
```

The current "Required skill loading" block is removed (subsumed by the new Step 0).

### 4. `apps/automation/.claude/agents/grammar-reviewer.md`

Same Step 0 block prepended; current "Required skill loading" block removed.

The "If any skill fails to load, return the draft unchanged (fail-open)" rule is **changed** to
fail-closed: return `SKIP_POST`. This trades availability for correctness — a reviewer that
silently skips its checks is worse than no post.

### 5. `apps/automation/.claude/agents/skill-planner.md`

Step 0 prepended. Channel skill is the only required skill, so:

```
## Step 0 — Skill loading (MANDATORY)
You MUST invoke `Skill(<channelSkill>)` first, before deciding the plan.
If it fails, output `{"writerSkills":[],"reviewerSkills":[],"notes":"channel skill failed to load"}`.
```

### 6. `apps/automation/.claude/agents/tag-generator.md`

Step 0 prepended (same channel-skill load). Tag-generator runs in its own `query()` so its
contract stays simple — single word, lowercase, no `#`.

### 7. `apps/automation/src/common/ai/post-generation.agent.ts`

#### New private state captured in `traceSubagents()`

```ts
private readonly logger = new Logger(PostGenerationAgent.name);

interface RunCapture {
  finalText:   string | null;            // last grammar-reviewer tool_result.text
  skillsUsed:  Map<string, Set<string>>; // subagentName → invoked skill names
  pendingTasks: Map<string, { subagent: string; startedAt: number }>;
}
```

`traceSubagents()` is enriched to:

- When `Skill` tool_use seen, resolve owner via `parent_tool_use_id` and record
  `capture.skillsUsed.get(owner).add(skillName)`.
- When `Task` tool_result seen and the spawned subagent is `grammar-reviewer`, copy the
  result text into `capture.finalText` (overwrites if multiple — last wins).

#### `generate()` orchestration

```ts
async generate(input: GenerateInput): Promise<GeneratedPost | 'SKIP_POST' | null> {
  const mainAgent = input.mode === 'news' ? 'main-news-agent' : 'main-simple-agent';
  const start = Date.now();
  const capture: RunCapture = {
    finalText: null,
    skillsUsed: new Map(),
    pendingTasks: new Map(),
  };

  let statusSignal: string = '';
  let costUsd = 0;
  let turns = 0;

  try {
    for await (const msg of query({ /* unchanged options */ })) {
      this.traceSubagents(mainAgent, msg, capture);
      if (msg.type === 'result') {
        turns = msg.num_turns ?? 0;
        if (msg.subtype === 'success') {
          statusSignal = msg.result?.trim() ?? '';
          costUsd = msg.total_cost_usd ?? 0;
        }
      }
    }
  } catch (err: any) {
    return this.failRun(mainAgent, start, err.message, capture);
  }

  // Status signal handling
  if (statusSignal === 'SKIP_POST') {
    await this.logRun({ mainAgent, start, capture, status: 'skipped' });
    return 'SKIP_POST';
  }

  // Source 1 (preferred): captured from stream
  let finalText = capture.finalText;
  let textSource: 'stream' | 'legacy-parse' | 'none' = finalText ? 'stream' : 'none';

  // Legacy fallback (only used during rollout window)
  if (!finalText && statusSignal && statusSignal !== 'DONE') {
    const legacy = this.parseResult(statusSignal);
    if (legacy.text) {
      finalText = legacy.text;
      textSource = 'legacy-parse';
    }
  }

  if (!finalText) {
    return this.failRun(mainAgent, start, 'no grammar-reviewer output captured', capture);
  }

  const cleaned = this.cleanFinalText(finalText);
  if (this.failsLengthGuard(cleaned)) {
    return this.failRun(mainAgent, start, `final text too short: ${cleaned.length} chars`, capture);
  }

  if (!this.skillGatePassed(input.mode, capture.skillsUsed)) {
    return this.failRun(mainAgent, start, 'skill-gate failed', capture);
  }

  const tag = await this.runTagGenerator(cleaned, input.channelSkill);

  await this.logRun({ mainAgent, start, capture, status: 'success', cleaned, tag, textSource, turns, costUsd });
  return { text: cleaned, tag };
}
```

#### `cleanFinalText(raw)`

```ts
private cleanFinalText(raw: string): string {
  let s = this.stripPreambles(raw);
  s = this.stripStrayMarkdown(s);
  return s.trim();
}

private stripStrayMarkdown(s: string): string {
  return s
    // Bold: **word** or __word__ → word (strip — Telegram HTML mode renders `**` literally)
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    // Italic single-asterisk only when bracketed by spaces / line edges
    .replace(/(^|\s)\*([^*\n]+)\*(\s|$)/g, '$1$2$3')
    // Horizontal rule lines
    .replace(/^[ \t]*-{3,}[ \t]*$/gm, '')
    // Collapse triple+ newlines created by removed lines
    .replace(/\n{3,}/g, '\n\n');
}
```

`stripPreambles` keeps existing patterns; we now apply it to the captured `text` rather
than the orchestrator wrapper.

#### `skillGatePassed(mode, skillsUsed)`

```ts
private skillGatePassed(mode: PostMode, used: Map<string, Set<string>>): boolean {
  const expected: Array<[string, number]> = [
    ['skill-planner',    1],
    ['post-writer',      2],
    ['grammar-reviewer', 2],
  ];

  for (const [name, min] of expected) {
    const count = used.get(name)?.size ?? 0;
    if (count < min) {
      this.logger.warn(`[skill-gate] ${name} loaded ${count} skills, expected >= ${min}`);
      return false;
    }
  }
  return true;
}
```

The gate runs ONLY against the orchestrator's run. Tag-generator's skill use is checked
separately inside `runTagGenerator`.

#### `runTagGenerator(post, channelSkill)`

```ts
private async runTagGenerator(post: string, channelSkill: string): Promise<string> {
  const promptObj = { channelSkill, post };
  let raw = '';
  let skillCalls = 0;

  try {
    for await (const msg of query({
      prompt: JSON.stringify(promptObj),
      options: {
        cwd:                             this.cwd,
        settingSources:                  ['project'],
        agent:                           'tag-generator',
        permissionMode:                  'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns:                        3,
        allowedTools:                    ['Skill'],
      },
    })) {
      if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block?.type === 'tool_use' && block.name === 'Skill') skillCalls++;
        }
      }
      if (msg.type === 'result' && msg.subtype === 'success') {
        raw = msg.result?.trim() ?? '';
      }
    }
  } catch (err: any) {
    this.logger.warn(`tag-generator failed: ${err.message}`);
    return '';
  }

  if (skillCalls === 0) {
    this.logger.warn('tag-generator did not invoke Skill — discarding tag');
    return '';
  }
  return this.cleanTag(raw);  // existing helper
}
```

#### `logRun(...)`

Replaces the current single `aiLogger.log({...})` call with a richer structured payload that
includes per-subagent skill counts, text source, and tag info (sec 5 telemetry).

## Data flow (sequence)

```
strategy           PostGenerationAgent          Agent SDK         subagents
   │                       │                         │                │
   │ generate(input)       │                         │                │
   ├──────────────────────►│                         │                │
   │                       │ query(orchestrator)     │                │
   │                       ├────────────────────────►│                │
   │                       │                         │ Task → planner │
   │                       │                         ├───────────────►│
   │                       │                         │   Skill(chan)  │
   │                       │                         │◄───────────────┤
   │                       │ traceSubagents          │                │
   │                       │  records skillsUsed     │                │
   │                       │                         │ Task → writer  │
   │                       │                         ├───────────────►│
   │                       │                         │   Skill x N    │
   │                       │                         │◄───────────────┤
   │                       │                         │ Task → reviewer│
   │                       │                         ├───────────────►│
   │                       │                         │   Skill x N    │
   │                       │                         │   tool_result  │
   │                       │                         │◄───────────────┤
   │                       │ traceSubagents          │                │
   │                       │  capture.finalText =    │                │
   │                       │    last reviewer result │                │
   │                       │                         │ result: "DONE" │
   │                       │◄────────────────────────┤                │
   │                       │                         │                │
   │                       │ cleanFinalText          │                │
   │                       │ skillGatePassed?        │                │
   │                       │ query(tag-generator)    │                │
   │                       ├────────────────────────►│                │
   │                       │                         │ Skill(chan)    │
   │                       │                         ├───────────────►│
   │                       │                         │ result: "tech" │
   │                       │◄────────────────────────┤                │
   │ {text, tag}           │                         │                │
   │◄──────────────────────┤                         │                │
```

## Error handling matrix

| Scenario | Detection | Action |
|---|---|---|
| `query()` throws / SDK timeout / `maxTurns` exceeded | catch block | `aiLogger.log({ status: 'error' })`; return `null`; strategy retries next cron |
| Orchestrator returns `SKIP_POST` | `result.result === 'SKIP_POST'` | `logRun(skipped)`; return `'SKIP_POST'`; strategy marks dedup |
| Orchestrator returns `DONE` but `capture.finalText === null` | post-loop check | log `no grammar-reviewer output`; return `null` |
| Orchestrator returns markdown wrapper (legacy behaviour) | `result.result !== 'DONE'/'SKIP_POST'` AND no captured text | run `parseResult()` legacy path; if extracts text → `textSource: 'legacy-parse'`; else `null` |
| `cleanFinalText` result < 80 chars after HTML strip | length guard | warn-log; return `null` |
| Skill-gate fails | post-loop count check | warn-log with full skillsUsed map; return `null` |
| `runTagGenerator` throws / no Skill calls / empty | inner try/catch + `skillCalls === 0` | empty tag, post still publishes |

## Telemetry additions

`StructuredLoggerService.aiResponse` payload extension (or a new `aiAgentRun` method, equivalent
shape, separate channel):

```ts
{
  agent: 'main-news-agent',
  model: 'agent-sdk',
  status: 'success' | 'error' | 'skipped',
  durationMs,
  costUsd,
  turns,
  skillsUsed: { 'skill-planner': ['channel-ai0-news'],
                'post-writer':   ['human-voice','anti-slop','channel-ai0-news'],
                'grammar-reviewer': ['grammar-ua','anti-slop','channel-ai0-news'] },
  textSource: 'stream' | 'legacy-parse' | 'none',
  finalLength: 423,
  tagWord: 'tech',
  tagSkillsUsed: ['channel-ai0-news'],
  error: null | string,
}
```

Used by `/analyze` admin command to surface skill-gate hit rate, legacy-parse rate, etc.

## Verification

1. **TypeScript:** `cd apps/automation && npx tsc -p tsconfig.json --noEmit` — no errors.
2. **Unit tests** (new `post-generation.agent.spec.ts`):
   - `cleanFinalText` strips `**Готовий пост:**` preamble + `---` separator + `**bold**` markdown.
   - `cleanFinalText` keeps Telegram HTML tags (`<b>`, `<i>`, `<a>`, `<code>`) intact.
   - `skillGatePassed` returns false when `post-writer` count < 2.
   - `skillGatePassed` returns true with all expected counts.
   - `cleanTag` rejects multi-word, Cyrillic, > 24 chars (existing behaviour, regression test).
3. **Smoke run, news mode:** `/run ai0-news` once. In stdout, expect:
   ```
   [main-news-agent] → skill-planner (...)
   [main-news-agent]   Skill(channel-ai0-news) ← skill-planner
   [main-news-agent] ← skill-planner (...): ok, ...
   [main-news-agent] → post-writer (...)
   [main-news-agent]   Skill(human-voice) ← post-writer
   [main-news-agent]   Skill(anti-slop) ← post-writer
   [main-news-agent]   Skill(channel-ai0-news) ← post-writer
   [main-news-agent] ← post-writer (...): ok, ...
   [main-news-agent] → grammar-reviewer (...)
   [main-news-agent]   Skill(grammar-ua) ← grammar-reviewer
   [main-news-agent]   Skill(anti-slop) ← grammar-reviewer
   [main-news-agent]   Skill(channel-ai0-news) ← grammar-reviewer
   [main-news-agent] ← grammar-reviewer (...): ok, ...
   ```
   Then a separate `[tag-generator]` run with one `Skill(channel-ai0-news)` call.
4. **Telegram check:** posted message has no `**`, no `Ось готовий пост:`, no `---` separator.
5. **Smoke run, news mode, paywall stub:** orchestrator outputs `SKIP_POST`; structured log
   shows `status: 'skipped'`; `published_posts` not incremented.
6. **Smoke run, simple mode:** `/run movies` (or any simple-mode strategy migrated by prior PR) —
   pipeline succeeds, no info-preparator dispatched, skill-gate passes.
7. **Smoke run, skill-gate fail simulation:** rename `human-voice/SKILL.md` to `human-voice/SKILL.md.bak`
   and trigger ai0-news. Expect orchestrator to either return `SKIP_POST` (post-writer fail-closed)
   OR skill-gate code-side rejects. Either way: no Telegram publish, log shows skill-gate failure.
   Restore file.
8. **Metrics check after one week:** `/analyze` shows
   - `textSource: 'stream'` ≥ 95%
   - `textSource: 'legacy-parse'` < 5%
   - `% posts with **` in body = 0
   - `% posts with preamble` ~ 0

## Migration & rollout

- One PR with all changes (5 agent files + post-generation.agent.ts + spec test).
- `parseResult()` and `stripPreambles()` are kept and marked `@deprecated` — referenced only by the
  legacy fallback branch.
- One-week soak with `/analyze` daily check.
- Cleanup PR after soak: delete `parseResult()`, delete `parseResult` legacy fallback in
  `generate()`, simplify `cleanFinalText` if any cleanup pattern has zero hits in a week.

## Known limitations

- **Hardcoded gate thresholds.** `skillGatePassed` uses `>= 2` for `post-writer` /
  `grammar-reviewer`. Today the planner always returns 3 skills (channel + human-voice/grammar-ua
  + anti-slop) so the threshold is safe. If a future channel skill overrides defaults to a
  shorter list (e.g. drop `anti-slop`), the gate may false-trip. Refinement (deferred): parse
  `skill-planner`'s `tool_result` JSON, extract `writerSkills.length` and `reviewerSkills.length`,
  use those as exact expected counts.
- **Fail-closed in `grammar-reviewer`.** Flipped from fail-open. Trade-off: a transient skill load
  error (rare — these are local file reads) now blocks the post until next cron rather than
  shipping a partly-reviewed draft. Worth it given the silent-quality-failure rate today.
- **Length-guard threshold.** Existing `< 80 chars after HTML strip` heuristic is kept verbatim.
  Not tuned in this design.

## Out of scope

- Migrating remaining strategies (movies, recipes, etc.) to `PostGenerationAgent` — separate PR.
- Removing `FormatterService` / `SummarizerService` / `ReviewAgent` — separate cleanup PR after
  all strategies migrate.
- `topic-router` and `topic-novelty-checker` agents — different pipeline, no skills required.
- Per-channel toggle for whether markdown bold should be converted to `<b>` vs stripped — current
  design always strips because Telegram HTML mode is the only used parse mode.
