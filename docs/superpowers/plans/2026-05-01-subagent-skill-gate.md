# Subagent Skill-Gate & Stream-Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture final post text from `grammar-reviewer`'s tool_result instead of the
orchestrator's wrapper, verify subagent `Skill` calls in code, and run `tag-generator` as
a separate `query()` — eliminating the `**Готовий пост:**` preamble leak and silent skill
loss.

**Architecture:** `PostGenerationAgent.generate()` runs the orchestrator, captures
`finalText` + `skillsUsed` from the SDK message stream, validates the skill-gate, runs a
second `query()` for the tag, and returns `{text, tag}`. The orchestrator emits only
`DONE`/`SKIP_POST` sentinels. Pure cleanup helpers (`stripStrayMarkdown`, `cleanFinalText`,
`skillGatePassed`) are unit-tested via Node's built-in `node:test` runner with `tsx` loader.

**Tech Stack:** NestJS 10, TypeScript 5, `@anthropic-ai/claude-agent-sdk`, Winston (existing),
`tsx` (added as dev dep at repo root for running `node:test`).

**Spec:** `docs/superpowers/specs/2026-05-01-subagent-skill-gate-design.md`

---

## File map

**Modified:**
- `apps/automation/src/common/ai/post-generation.agent.ts` — add helpers, refactor `generate`,
  add `runTagGenerator`, enrich `traceSubagents`.
- `apps/automation/.claude/agents/main-news-agent.md` — replace tag/JSON section with `DONE`/`SKIP_POST` sentinel.
- `apps/automation/.claude/agents/main-simple-agent.md` — same shape as news.
- `apps/automation/.claude/agents/post-writer.md` — prepend mandatory Step 0.
- `apps/automation/.claude/agents/grammar-reviewer.md` — prepend Step 0; flip fail-open to
  fail-closed (`SKIP_POST` on skill load failure).
- `apps/automation/.claude/agents/skill-planner.md` — prepend Step 0.
- `apps/automation/.claude/agents/tag-generator.md` — prepend Step 0.
- `package.json` (repo root) — add `tsx` as devDependency.

**Created:**
- `apps/automation/src/common/ai/post-generation.helpers.ts` — pure helpers extracted for
  unit-testability (`stripStrayMarkdown`, `cleanFinalText`, `skillGatePassed`).
- `apps/automation/src/common/ai/post-generation.helpers.test.ts` — Node `node:test`
  unit tests for the three helpers.

---

## Task 1: Set up minimal `tsx`-based test runner

**Files:**
- Modify: `package.json` (repo root)

- [ ] **Step 1: Add `tsx` as repo-root devDependency**

Run:
```bash
pnpm add -D -w tsx
```

Expected: `package.json` (root) gains `"tsx": "^4.x"` under `devDependencies`. `pnpm-lock.yaml`
updated.

- [ ] **Step 2: Verify the test command works on a trivial probe**

Create a temporary file `apps/automation/_probe.test.ts` with:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('probe: tsx + node:test works', () => {
  assert.equal(1 + 1, 2);
});
```

Run from repo root:
```bash
npx tsx --test apps/automation/_probe.test.ts
```

Expected: one test passes, exit 0. Output contains `# pass 1` and `# fail 0`.

- [ ] **Step 3: Delete the probe**

Run:
```bash
rm apps/automation/_probe.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add tsx for ad-hoc node:test runs

Pre-req for forthcoming post-generation helper unit tests. No app code
changes; tsx is a dev-only TypeScript loader, not a runtime dependency.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add `stripStrayMarkdown` helper (TDD)

**Files:**
- Create: `apps/automation/src/common/ai/post-generation.helpers.ts`
- Create: `apps/automation/src/common/ai/post-generation.helpers.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/automation/src/common/ai/post-generation.helpers.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripStrayMarkdown } from './post-generation.helpers';

test('stripStrayMarkdown: removes ** bold **', () => {
  assert.equal(stripStrayMarkdown('Apple **launched** iOS 18.'), 'Apple launched iOS 18.');
});

test('stripStrayMarkdown: removes __bold__', () => {
  assert.equal(stripStrayMarkdown('__Big__ release today.'), 'Big release today.');
});

test('stripStrayMarkdown: removes single-asterisk italic when bracketed', () => {
  assert.equal(stripStrayMarkdown('A *small* update.'), 'A small update.');
});

test('stripStrayMarkdown: keeps mid-word asterisks (e.g. C*-style)', () => {
  // Should NOT match — no surrounding spaces/edges around the * pair.
  assert.equal(stripStrayMarkdown('a*b*c'), 'a*b*c');
});

test('stripStrayMarkdown: removes --- horizontal rule lines', () => {
  assert.equal(stripStrayMarkdown('Para 1.\n---\nPara 2.'), 'Para 1.\n\nPara 2.');
});

test('stripStrayMarkdown: collapses 3+ newlines to 2', () => {
  assert.equal(stripStrayMarkdown('a\n\n\n\nb'), 'a\n\nb');
});

test('stripStrayMarkdown: keeps Telegram HTML tags intact', () => {
  const input = '<b>News</b> — <i>Apple</i> released <code>iOS 18</code>.';
  assert.equal(stripStrayMarkdown(input), input);
});

test('stripStrayMarkdown: keeps anchor tags intact', () => {
  const input = '<a href="https://x.com">link</a> here.';
  assert.equal(stripStrayMarkdown(input), input);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from repo root:
```bash
npx tsx --test apps/automation/src/common/ai/post-generation.helpers.test.ts
```

Expected: error like `Cannot find module './post-generation.helpers'` or all 8 tests fail —
because the helper file does not yet exist.

- [ ] **Step 3: Create minimal implementation**

Create `apps/automation/src/common/ai/post-generation.helpers.ts`:
```ts
/**
 * Removes stray Markdown leaks that survive past the post-writer/grammar-reviewer
 * subagents. Telegram is configured for HTML parse mode, so any `**bold**` or
 * `_italic_` would render literally.
 *
 * Conservative: only strips the markdown wrappers; keeps the inner text. Does not
 * touch HTML tags, URLs, or mid-word asterisks (rare but possible in code-style
 * tokens like `C*`).
 */
export function stripStrayMarkdown(s: string): string {
  return s
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*(\s|$)/g, '$1$2$3')
    .replace(/^[ \t]*-{3,}[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx tsx --test apps/automation/src/common/ai/post-generation.helpers.test.ts
```

Expected: `# pass 8`, `# fail 0`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/common/ai/post-generation.helpers.ts \
        apps/automation/src/common/ai/post-generation.helpers.test.ts
git commit -m "feat(ai): add stripStrayMarkdown helper

Strips ** bold, __ bold, single-asterisk italics, and --- separators
that leak past the agent pipeline. Telegram HTML parse mode renders
markdown literally so this is a defensive cleanup before publish.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add `cleanFinalText` helper (TDD)

**Files:**
- Modify: `apps/automation/src/common/ai/post-generation.helpers.ts`
- Modify: `apps/automation/src/common/ai/post-generation.helpers.test.ts`

`cleanFinalText` combines `stripPreambles` (currently a private method on `PostGenerationAgent`)
with `stripStrayMarkdown`. We extract `stripPreambles` from the agent class into the helpers
file so both helpers live together.

- [ ] **Step 1: Write the failing tests**

Append to `apps/automation/src/common/ai/post-generation.helpers.test.ts`:
```ts
import { cleanFinalText } from './post-generation.helpers';

test('cleanFinalText: strips "Ось готовий пост:" preamble', () => {
  const input = 'Ось готовий пост:\n\nApple оголосила нову модель.';
  assert.equal(cleanFinalText(input), 'Apple оголосила нову модель.');
});

test('cleanFinalText: strips "**Готовий пост:**" markdown preamble', () => {
  const input = '**Готовий пост:**\n\n---\n\nApple оголосила.';
  assert.equal(cleanFinalText(input), 'Apple оголосила.');
});

test('cleanFinalText: strips "<b>Final post:</b>" HTML preamble', () => {
  const input = '<b>Final post:</b>\n\nApple announced.';
  assert.equal(cleanFinalText(input), 'Apple announced.');
});

test('cleanFinalText: strips json/markdown/html code fences', () => {
  const input = '```html\n<b>Apple</b> announced.\n```';
  assert.equal(cleanFinalText(input), '<b>Apple</b> announced.');
});

test('cleanFinalText: chains preamble+markdown+separator removal', () => {
  const input = '**Готовий пост:**\n\n---\n\n**Apple** released **iOS 18** — read more.';
  assert.equal(cleanFinalText(input), 'Apple released iOS 18 — read more.');
});

test('cleanFinalText: keeps clean Telegram HTML untouched', () => {
  const input = '<b>Apple</b> випустила <i>iOS 18</i>.\n\n<a href="https://example.com">Деталі</a>.';
  assert.equal(cleanFinalText(input), input);
});

test('cleanFinalText: trims trailing whitespace', () => {
  assert.equal(cleanFinalText('  Apple announced.\n\n  '), 'Apple announced.');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx tsx --test apps/automation/src/common/ai/post-generation.helpers.test.ts
```

Expected: import error or new tests fail (`cleanFinalText` not exported yet).

- [ ] **Step 3: Add `stripPreambles` and `cleanFinalText` to helpers file**

Append to `apps/automation/src/common/ai/post-generation.helpers.ts`:
```ts
/**
 * Strips common preambles models add despite explicit "no preamble" rules:
 * "Пост:", "Ось готовий пост:", "**Готовий пост:**", "<b>Готовий пост:</b>",
 * code fences, etc. Same regex set used previously inside PostGenerationAgent.
 */
export function stripPreambles(raw: string): string {
  return raw
    .replace(
      /^\s*(?:\*\*|__|<b>|<strong>)\s*(Ось\s+)?(готов(ий|ого)\s+)?пост\s*[:：]?\s*(?:\*\*|__|<\/b>|<\/strong>)\s*$/gim,
      '',
    )
    .replace(
      /^\s*(?:\*\*|__|<b>|<strong>)\s*final\s+post\s*[:：]?\s*(?:\*\*|__|<\/b>|<\/strong>)\s*$/gim,
      '',
    )
    .replace(/^\s*(Ось\s+)?(готов(ий|ого)\s+)?пост\s*[:：]\s*$/gim, '')
    .replace(/^\s*final\s+post\s*[:：]\s*$/gim, '')
    .replace(/^```(?:json|markdown|html|text)?\s*\n/i, '')
    .replace(/\n```\s*$/i, '')
    .trim();
}

/**
 * Full final-text cleanup pipeline applied AFTER capturing post text from
 * grammar-reviewer's tool_result. Combines preamble stripping + stray-markdown
 * removal. Order matters: preambles first (so their bold/HTML wrappers are
 * removed before we try to strip standalone bold), then markdown.
 */
export function cleanFinalText(raw: string): string {
  const noPreamble = stripPreambles(raw);
  const noMarkdown = stripStrayMarkdown(noPreamble);
  return noMarkdown.trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx tsx --test apps/automation/src/common/ai/post-generation.helpers.test.ts
```

Expected: `# pass 15`, `# fail 0` (8 from Task 2 + 7 new).

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/common/ai/post-generation.helpers.ts \
        apps/automation/src/common/ai/post-generation.helpers.test.ts
git commit -m "feat(ai): add cleanFinalText helper (preamble + markdown strip)

Combines preamble stripping (existing regex set) with stripStrayMarkdown
into a single post-capture cleanup pipeline. Extracts the regex set from
PostGenerationAgent into the shared helpers module.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Add `skillGatePassed` helper (TDD)

**Files:**
- Modify: `apps/automation/src/common/ai/post-generation.helpers.ts`
- Modify: `apps/automation/src/common/ai/post-generation.helpers.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/automation/src/common/ai/post-generation.helpers.test.ts`:
```ts
import { skillGatePassed } from './post-generation.helpers';

test('skillGatePassed: passes with full set', () => {
  const used = new Map([
    ['skill-planner',    new Set(['channel-ai0-news'])],
    ['post-writer',      new Set(['human-voice', 'anti-slop', 'channel-ai0-news'])],
    ['grammar-reviewer', new Set(['grammar-ua', 'anti-slop', 'channel-ai0-news'])],
  ]);
  const result = skillGatePassed(used);
  assert.equal(result.ok, true);
  assert.equal(result.failedSubagent, null);
});

test('skillGatePassed: fails when post-writer loaded only 1 skill', () => {
  const used = new Map([
    ['skill-planner',    new Set(['channel-ai0-news'])],
    ['post-writer',      new Set(['anti-slop'])],
    ['grammar-reviewer', new Set(['grammar-ua', 'anti-slop', 'channel-ai0-news'])],
  ]);
  const result = skillGatePassed(used);
  assert.equal(result.ok, false);
  assert.equal(result.failedSubagent, 'post-writer');
  assert.equal(result.actualCount, 1);
  assert.equal(result.expectedMin, 2);
});

test('skillGatePassed: fails when skill-planner missing entirely', () => {
  const used = new Map([
    ['post-writer',      new Set(['human-voice', 'anti-slop'])],
    ['grammar-reviewer', new Set(['grammar-ua', 'anti-slop'])],
  ]);
  const result = skillGatePassed(used);
  assert.equal(result.ok, false);
  assert.equal(result.failedSubagent, 'skill-planner');
  assert.equal(result.actualCount, 0);
});

test('skillGatePassed: fails when grammar-reviewer absent', () => {
  const used = new Map([
    ['skill-planner', new Set(['channel-ai0-news'])],
    ['post-writer',   new Set(['human-voice', 'anti-slop'])],
  ]);
  const result = skillGatePassed(used);
  assert.equal(result.ok, false);
  assert.equal(result.failedSubagent, 'grammar-reviewer');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx tsx --test apps/automation/src/common/ai/post-generation.helpers.test.ts
```

Expected: import error / new tests fail.

- [ ] **Step 3: Add `skillGatePassed` to helpers file**

Append to `apps/automation/src/common/ai/post-generation.helpers.ts`:
```ts
export interface SkillGateResult {
  ok:              boolean;
  failedSubagent:  string | null;
  actualCount:     number;
  expectedMin:     number;
}

/**
 * Subagents that must invoke `Skill(...)` at least N times for a run to be
 * considered fully gated. Channel-skill is always 1 (planner). Writer/reviewer
 * always need at least 2 (channel + at least one cross-cutting style skill).
 *
 * Hardcoded thresholds are documented as a known limitation in the spec; future
 * refinement parses skill-planner's tool_result for exact counts.
 */
const SKILL_GATE_THRESHOLDS: Array<[string, number]> = [
  ['skill-planner',    1],
  ['post-writer',      2],
  ['grammar-reviewer', 2],
];

export function skillGatePassed(
  used: Map<string, Set<string>>,
): SkillGateResult {
  for (const [name, expectedMin] of SKILL_GATE_THRESHOLDS) {
    const actualCount = used.get(name)?.size ?? 0;
    if (actualCount < expectedMin) {
      return { ok: false, failedSubagent: name, actualCount, expectedMin };
    }
  }
  return { ok: true, failedSubagent: null, actualCount: 0, expectedMin: 0 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx tsx --test apps/automation/src/common/ai/post-generation.helpers.test.ts
```

Expected: `# pass 19`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/common/ai/post-generation.helpers.ts \
        apps/automation/src/common/ai/post-generation.helpers.test.ts
git commit -m "feat(ai): add skillGatePassed helper

Code-side audit of subagent Skill tool calls. Returns a structured result
with the failing subagent and counts for telemetry. Thresholds are
hardcoded for now (>=2 for writer/reviewer, >=1 for planner) per spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Refactor `traceSubagents` to populate `RunCapture`

**Files:**
- Modify: `apps/automation/src/common/ai/post-generation.agent.ts`

The existing `traceSubagents` only logs; we need it to also populate
a structured `RunCapture` (skillsUsed Map + finalText from grammar-reviewer's tool_result).

- [ ] **Step 1: Update `RunCapture` interface and `traceSubagents` signature**

In `apps/automation/src/common/ai/post-generation.agent.ts`:

Add this interface near the top (after `GeneratedPost`):
```ts
interface RunCapture {
  /** Last grammar-reviewer Task tool_result text — the captured post body. */
  finalText:    string | null;
  /** Per-subagent set of distinct Skill names invoked. */
  skillsUsed:   Map<string, Set<string>>;
  /** In-flight Task dispatches (id → subagent name + start ts), used by traceSubagents. */
  pendingTasks: Map<string, { subagent: string; startedAt: number }>;
}
```

Replace the `traceSubagents` method body. Old signature accepts a `pending` map; new one
accepts `RunCapture`:
```ts
private traceSubagents(
  mainAgent: string,
  msg: any,
  capture: RunCapture,
): void {
  // Assistant blocks: tool_use of Task or Skill
  if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
    const parentId = (msg as any).parent_tool_use_id as string | undefined;
    const owner    = parentId
      ? capture.pendingTasks.get(parentId)?.subagent ?? 'subagent'
      : mainAgent;

    for (const block of msg.message.content) {
      if (block?.type !== 'tool_use') continue;

      if (block.name === 'Task') {
        const subagent = block.input?.subagent_type ?? 'unknown';
        const id = block.id as string;
        capture.pendingTasks.set(id, { subagent, startedAt: Date.now() });
        this.logger.debug(`[${mainAgent}] → ${subagent} (${id.slice(-8)})`);
      } else if (block.name === 'Skill') {
        const skillName: string =
          block.input?.skill ??
          block.input?.name ??
          (typeof block.input === 'string' ? block.input : null) ??
          'unknown';
        if (!capture.skillsUsed.has(owner)) capture.skillsUsed.set(owner, new Set());
        capture.skillsUsed.get(owner)!.add(skillName);
        this.logger.debug(`[${mainAgent}]   Skill(${skillName}) ← ${owner}`);
      }
    }
    return;
  }

  // User-role blocks: tool_result for in-flight Task IDs
  if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block?.type !== 'tool_result') continue;
      const id = block.tool_use_id as string;
      const entry = capture.pendingTasks.get(id);
      if (!entry) continue;
      capture.pendingTasks.delete(id);

      const ms = Date.now() - entry.startedAt;
      const textBlock: string = Array.isArray(block.content)
        ? block.content.find((c: any) => c?.type === 'text')?.text ?? ''
        : typeof block.content === 'string' ? block.content : '';
      const chars = textBlock.length;
      const flag  = block.is_error ? 'ERROR' : 'ok';

      // Capture grammar-reviewer's last successful output as the post body.
      // "Last wins" — if the orchestrator re-runs the reviewer, we use the latest.
      if (entry.subagent === 'grammar-reviewer' && !block.is_error && textBlock.trim()) {
        capture.finalText = textBlock;
      }

      this.logger.debug(
        `[${mainAgent}] ← ${entry.subagent} (${id.slice(-8)}): ${flag}, ${chars} chars, ${ms}ms`,
      );
    }
  }
}
```

- [ ] **Step 2: Update `generate()` call site to pass new `capture` shape**

Inside `generate()` find this block (around line 56):
```ts
const pendingTasks = new Map<string, { subagent: string; startedAt: number }>();

for await (const msg of query({
  ...
})) {
  this.traceSubagents(mainAgent, msg, pendingTasks);
  ...
```

Replace with:
```ts
const capture: RunCapture = {
  finalText:    null,
  skillsUsed:   new Map(),
  pendingTasks: new Map(),
};

for await (const msg of query({
  // (options unchanged)
  ...
})) {
  this.traceSubagents(mainAgent, msg, capture);
  ...
```

Leave the rest of `generate()` unchanged for now (Task 6 will use `capture.finalText`).

- [ ] **Step 3: TypeScript compiles**

Run:
```bash
cd apps/automation && npx tsc -p tsconfig.json --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/automation/src/common/ai/post-generation.agent.ts
git commit -m "refactor(ai): traceSubagents populates RunCapture

Extracts skillsUsed Map and grammar-reviewer finalText from the SDK
message stream. Behaviour unchanged — capture is populated but not yet
consumed; generate() still parses orchestrator output. Wiring follows
in next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Switch `generate` to stream-captured text with legacy fallback

**Files:**
- Modify: `apps/automation/src/common/ai/post-generation.agent.ts`

Use `capture.finalText` as the primary source, fall back to `parseResult` for backwards
compatibility during rollout.

- [ ] **Step 1: Import the new helpers**

At the top of `post-generation.agent.ts`, after existing imports:
```ts
import { cleanFinalText, skillGatePassed } from './post-generation.helpers';
```

- [ ] **Step 2: Replace the post-stream parsing logic in `generate`**

Find this block (around lines 119–141 of the original file — the section that reads
`finalText`, runs `parseResult`, applies the length guard):
```ts
this.logger.debug(
  `${mainAgent} finished: ${turns} turns, $${costUsd.toFixed(4)}, ${durationMs}ms`,
);

if (!finalText)              return null;
if (finalText === 'SKIP_POST') return 'SKIP_POST';

const parsed = this.parseResult(finalText);

// Sanity guard: if the agent returned an empty / near-empty body, treat
// the run as failed so the strategy retries on the next cron rather than
// publishing a junk post (e.g. "**Готовий пост:**" + blank body, which
// happened in production when sonnet panicked mid-orchestration).
const MIN_BODY_CHARS = 80;
if (parsed.text.replace(/<[^>]+>/g, '').trim().length < MIN_BODY_CHARS) {
  this.logger.warn(
    `Agent returned suspiciously short body (${parsed.text.length} chars) — treating as failure`,
  );
  return null;
}

return parsed;
```

Replace with:
```ts
this.logger.debug(
  `${mainAgent} finished: ${turns} turns, $${costUsd.toFixed(4)}, ${durationMs}ms`,
);

const statusSignal = finalText?.trim() ?? '';
if (statusSignal === 'SKIP_POST') return 'SKIP_POST';

// Source priority:
//   1. capture.finalText  — grammar-reviewer's last tool_result (preferred, post-refactor)
//   2. legacy parseResult — if orchestrator returned a markdown wrapper instead of "DONE"
let textRaw: string | null = null;
let textSource: 'stream' | 'legacy-parse' | 'none' = 'none';

if (capture.finalText) {
  textRaw    = capture.finalText;
  textSource = 'stream';
} else if (statusSignal && statusSignal !== 'DONE') {
  // Orchestrator emitted text directly (legacy) — try to recover.
  const legacy = this.parseResult(statusSignal);
  if (legacy.text) {
    textRaw    = legacy.text;
    textSource = 'legacy-parse';
  }
}

if (!textRaw) {
  this.logger.warn(
    `${mainAgent}: no post text (statusSignal=${statusSignal.slice(0, 30)}, finalText=null) — treating as failure`,
  );
  return null;
}

const cleaned = cleanFinalText(textRaw);

const MIN_BODY_CHARS = 80;
if (cleaned.replace(/<[^>]+>/g, '').trim().length < MIN_BODY_CHARS) {
  this.logger.warn(
    `Agent returned suspiciously short body (${cleaned.length} chars, source=${textSource}) — treating as failure`,
  );
  return null;
}

const gate = skillGatePassed(capture.skillsUsed);
if (!gate.ok) {
  this.logger.warn(
    `[skill-gate] ${gate.failedSubagent} loaded ${gate.actualCount} skills, expected >= ${gate.expectedMin}`,
  );
  return null;
}

// Tag is computed in a separate query (Task 7). For now return empty tag.
return { text: cleaned, tag: '' };
```

- [ ] **Step 3: Mark `parseResult` and the in-class `stripPreambles` as deprecated**

Above the `parseResult` private method, replace its existing JSDoc with:
```ts
/**
 * @deprecated Legacy fallback — used only when the orchestrator returns a markdown
 *   wrapper instead of the new `DONE`/`SKIP_POST` sentinel. Will be removed after
 *   one week of monitoring shows `textSource: 'legacy-parse'` is < 5%.
 *
 *   New code uses `capture.finalText` (stream-captured grammar-reviewer output)
 *   and the `cleanFinalText` helper from `post-generation.helpers.ts`.
 */
```

Above `stripPreambles`:
```ts
/**
 * @deprecated Legacy — moved to `post-generation.helpers.ts` as a shared export.
 *   Retained here only because `parseResult` still references it during rollout.
 */
```

(No code change to either method body — they keep working for the legacy fallback path.)

- [ ] **Step 4: TypeScript compiles**

Run:
```bash
cd apps/automation && npx tsc -p tsconfig.json --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/common/ai/post-generation.agent.ts
git commit -m "refactor(ai): generate() prefers stream-captured finalText

Captures grammar-reviewer's last tool_result as the post body, falling
back to parseResult only when the orchestrator returns a legacy markdown
wrapper. Adds skill-gate enforcement: if any required subagent loaded
fewer skills than the threshold, generate() returns null and the
strategy retries on the next cron.

Tag is empty for now — separate tag-generator query lands in next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Add `runTagGenerator` and wire it in

**Files:**
- Modify: `apps/automation/src/common/ai/post-generation.agent.ts`

- [ ] **Step 1: Add `runTagGenerator` private method**

In `PostGenerationAgent` class, after `runOrchestrator`/`generate` (roughly after the
existing `parseResult` block), add:

```ts
/**
 * Computes the tag in an isolated query() run against the tag-generator subagent.
 * This separates tag concerns from post-text generation and lets us treat tag
 * failures as soft (empty tag → strategy falls back to RSS tags).
 *
 * Skill-gate equivalent: tag-generator must invoke `Skill(<channelSkill>)` at
 * least once. If it doesn't, we discard the tag (return empty).
 */
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
  return this.cleanTag(raw);
}
```

(Note: `query` and the Logger are already imported. `this.cleanTag` is already a private
method on the class.)

- [ ] **Step 2: Wire `runTagGenerator` into `generate`**

Find the closing return in `generate()` (added in Task 6):
```ts
// Tag is computed in a separate query (Task 7). For now return empty tag.
return { text: cleaned, tag: '' };
```

Replace with:
```ts
const tag = await this.runTagGenerator(cleaned, input.channelSkill);
return { text: cleaned, tag };
```

- [ ] **Step 3: TypeScript compiles**

Run:
```bash
cd apps/automation && npx tsc -p tsconfig.json --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/automation/src/common/ai/post-generation.agent.ts
git commit -m "feat(ai): tag computed in separate tag-generator query

Removes tag responsibility from main-(news|simple)-agent. The new
runTagGenerator runs a small (maxTurns=3, allowedTools=['Skill']) query
against tag-generator. Soft-fails: if the tag run errors or skips Skill
loading, we return empty tag and strategy falls back to RSS tags.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Rich structured logging for run summary

**Files:**
- Modify: `apps/automation/src/common/ai/post-generation.agent.ts`

The current `aiLogger.log(...)` call writes only `agent / model / status / input / output /
error / durationMs`. We additionally emit a richer `ai_response` entry directly via
`StructuredLoggerService` so `/analyze` can surface skill-gate metrics.

- [ ] **Step 1: Inject StructuredLoggerService**

In `post-generation.agent.ts` add to the imports:
```ts
import { StructuredLoggerService } from '../logging/structured-logger.service';
```

In the `constructor`, add the new dependency:
```ts
constructor(
  private readonly aiLogger: AiLoggerService,
  private readonly structured: StructuredLoggerService,
) {}
```

- [ ] **Step 2: Verify `StructuredLoggerService` is exported by `LoggingModule` and importable**

Run:
```bash
grep -n "StructuredLoggerService" apps/automation/src/common/logging/logging.module.ts
```

Expected: line includes `providers:` and `exports:` containing `StructuredLoggerService`.
If `LoggingModule` is already imported by `CommonModule` (it is — confirmed during context
exploration), no module wiring change is needed.

- [ ] **Step 3: Build a rich run-summary helper**

In `PostGenerationAgent` add a private method:
```ts
private logRunSummary(args: {
  mainAgent: string;
  status:    'success' | 'error' | 'skipped';
  capture:   RunCapture;
  durationMs: number;
  costUsd:   number;
  turns:     number;
  cleaned?:  string;
  tag?:      string;
  textSource?: 'stream' | 'legacy-parse' | 'none';
  error?:    string;
}): void {
  const skillsUsed: Record<string, string[]> = {};
  for (const [name, set] of args.capture.skillsUsed) skillsUsed[name] = [...set];

  this.structured.log({
    category: 'ai_response',
    level:    args.status === 'error' ? 'error' : 'info',
    message:  `${args.mainAgent}/agent-sdk ← ${args.status} (${args.durationMs}ms)`,
    data: {
      agent:       args.mainAgent,
      model:       'agent-sdk',
      status:      args.status,
      durationMs:  args.durationMs,
      costUsd:     args.costUsd,
      turns:       args.turns,
      skillsUsed,
      textSource:  args.textSource ?? 'none',
      finalLength: args.cleaned?.length ?? 0,
      tagWord:     args.tag ?? '',
      error:       args.error ?? null,
    },
  });
}
```

- [ ] **Step 4: Call `logRunSummary` from `generate` at each exit**

Refactor `generate` so that every return path also calls `logRunSummary`. The simplest
shape: keep a mutable `summary` object inside `generate`, populate fields as we go, and
call `logRunSummary` once just before each `return`. Concretely, at the *end* of `generate`,
right before `return { text: cleaned, tag };`, add:

```ts
this.logRunSummary({
  mainAgent,
  status:     'success',
  capture,
  durationMs,
  costUsd,
  turns,
  cleaned,
  tag,
  textSource,
});
```

For each early-return path (`SKIP_POST`, no text captured, length-guard fail, skill-gate
fail), add a corresponding `this.logRunSummary({ status: 'skipped' or 'error', error: '...' })`
call before the `return`. Use the existing `durationMs = Date.now() - start` value (compute
it once just after the SDK loop, before any returns) — currently line 107.

(The existing `aiLogger.log({...})` calls remain; they continue to write the basic record
to the `ai_logs` DB table.)

- [ ] **Step 5: TypeScript compiles**

Run:
```bash
cd apps/automation && npx tsc -p tsconfig.json --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/automation/src/common/ai/post-generation.agent.ts
git commit -m "feat(ai): rich structured log per generate() run

Adds a detailed ai_response record with skillsUsed map, textSource,
finalLength, tagWord — fed into the /analyze admin command so we can
track skill-gate hit rate, legacy-parse rate, and tag success per
strategy. Existing ai_logs DB writes (basic record) are unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Update `main-news-agent.md` (DONE/SKIP_POST sentinel)

**Files:**
- Modify: `apps/automation/.claude/agents/main-news-agent.md`

- [ ] **Step 1: Replace sections 5 and 6 with the sentinel rule**

Open `apps/automation/.claude/agents/main-news-agent.md`. Find the existing block starting
with `### 5. Tag` and ending at the `## Hard rules` section (inclusive of the JSON examples).
Replace everything from `### 5. Tag` through the final fenced JSON example with:

```markdown
### 5. Final output — STATUS ONLY
After grammar-reviewer returns successfully, output the literal three-letter
string `DONE` and nothing else. Do NOT echo the post text. Do NOT add JSON.
Do NOT add quotes, code fences, preambles ("Ось готовий пост:"), or any wrapper.

The NestJS layer captures the post text directly from grammar-reviewer's
tool_result and runs tag-generator separately — your job ends at "DONE".

Examples (correct):
```
DONE
```
```
SKIP_POST
```

Examples (WRONG — these will fail the run):
- `Готово!` ← only `DONE` is accepted
- `Ось готовий пост:\n\n<post text>` ← never echo post text
- `{"text":"...","tag":"..."}` ← no JSON envelope, captured automatically

## Skip signal
If the source is unusable at ANY step (broken HTML, paywall stub, obvious spam,
empty content) — output the literal string `SKIP_POST` alone. Do not continue
the chain.

## Hard rules
- Never write post prose yourself. Always delegate to `post-writer` and
  `grammar-reviewer`.
- Never echo the post text in your final reply — it is captured automatically
  from grammar-reviewer's tool_result.
- Always run skill-planner → (info-preparator if needed) → post-writer →
  grammar-reviewer in order.
- Final reply is exactly one of: `DONE`, `SKIP_POST`. Nothing else.
```

(The earlier sections — `## Subagents available via Task`, `## Input`, `## Sequence` steps
1–4 — stay unchanged. Only the final-output and hard-rules sections are replaced. Tag-generator
is no longer a step the orchestrator runs, so step "5. Tag" disappears entirely.)

- [ ] **Step 2: Verify the file shape**

Run:
```bash
grep -E "^### |^## " apps/automation/.claude/agents/main-news-agent.md
```

Expected: section headings include `### 1. Plan skills`, `### 2. Enrich (conditional)`,
`### 3. Draft`, `### 4. Review`, `### 5. Final output — STATUS ONLY`, `## Skip signal`,
`## Hard rules`. **No** `### 5. Tag` heading, **no** `### 6. Emit final output — STRICT JSON`
heading.

- [ ] **Step 3: Commit**

```bash
git add apps/automation/.claude/agents/main-news-agent.md
git commit -m "feat(agents): main-news-agent emits DONE/SKIP_POST sentinel

Removes JSON-envelope output contract that production never honoured (0/29
runs in last 3 days). Post text now flows from grammar-reviewer's
tool_result via stream capture; tag is computed by a separate
tag-generator query.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Update `main-simple-agent.md`

**Files:**
- Modify: `apps/automation/.claude/agents/main-simple-agent.md`

- [ ] **Step 1: Apply the same sentinel-output transformation**

Open `apps/automation/.claude/agents/main-simple-agent.md`. Find the existing block starting
with `### 4. Tag` and ending at the file's final `## Hard rules` section. Replace from
`### 4. Tag` through the end of the JSON example block with:

```markdown
### 4. Final output — STATUS ONLY
After grammar-reviewer returns successfully, output the literal three-letter
string `DONE` and nothing else. Do NOT echo the post text. Do NOT add JSON.
Do NOT add quotes, code fences, preambles ("Ось готовий пост:"), or any wrapper.

The NestJS layer captures the post text directly from grammar-reviewer's
tool_result and runs tag-generator separately.

Examples (correct):
```
DONE
```
```
SKIP_POST
```

## Skip signal
If input is empty or malformed at any step, output the literal string `SKIP_POST`
alone (no JSON, no quotes).

## Hard rules
- Never fetch, search, or write prose yourself.
- Never echo the post text in your final reply — captured automatically from
  grammar-reviewer's tool_result.
- Always run skill-planner → post-writer → grammar-reviewer in order.
- Final reply is exactly one of: `DONE`, `SKIP_POST`. Nothing else.
```

- [ ] **Step 2: Verify the file shape**

Run:
```bash
grep -E "^### |^## " apps/automation/.claude/agents/main-simple-agent.md
```

Expected: `### 1. Plan skills`, `### 2. Draft`, `### 3. Review`, `### 4. Final output —
STATUS ONLY`, `## Skip signal`, `## Hard rules`.

- [ ] **Step 3: Commit**

```bash
git add apps/automation/.claude/agents/main-simple-agent.md
git commit -m "feat(agents): main-simple-agent emits DONE/SKIP_POST sentinel

Mirrors the main-news-agent change. Tag-generator step is removed
because tag is now computed in a separate post-NestJS query.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Add Step 0 to `post-writer.md`

**Files:**
- Modify: `apps/automation/.claude/agents/post-writer.md`

- [ ] **Step 1: Replace the existing skill-loading block**

Open `apps/automation/.claude/agents/post-writer.md`. Find the existing block:
```
## Required skill loading — do this FIRST, before writing a single sentence
For every name in `skills`, invoke `Skill(<name>)` and read its full contents. Do not skip.
Do not proceed to drafting until every skill in the list is loaded.

If any skill fails to load, STOP and return the literal string `SKIP_POST`.
```

Replace it (matching the surrounding structure) with:

```markdown
## Step 0 — Skill loading (MANDATORY, BEFORE ANYTHING ELSE)
The user message contains a `skills` array, e.g.
`["human-voice", "anti-slop", "channel-X"]`.

You MUST invoke `Skill(<name>)` for EVERY entry in that array. This is non-negotiable.
Emit one tool call per skill — in any order — BEFORE drafting a single character of
post text.

If `skills` has 3 entries, you MUST emit 3 `Skill` tool calls.

If any `Skill` call fails or returns an error, your response MUST be the literal string
`SKIP_POST` and nothing else. Do not draft from memory. Do not improvise.

Only after all `Skill` calls have completed successfully may you continue to drafting.
```

- [ ] **Step 2: Verify section order**

Run:
```bash
grep -E "^## " apps/automation/.claude/agents/post-writer.md
```

Expected: `## Input`, `## Step 0 — Skill loading (MANDATORY, BEFORE ANYTHING ELSE)`,
`## Drafting rules (baseline — loaded skills tighten further)`, `## Hard bans — NestJS adds these, you must NOT`,
`## Output`. The Step 0 section appears AFTER `## Input` but BEFORE drafting rules.

- [ ] **Step 3: Commit**

```bash
git add apps/automation/.claude/agents/post-writer.md
git commit -m "feat(agents): post-writer Step 0 mandatory skill loading

Stronger phrasing: explicit count check ('if skills has 3 entries you
MUST emit 3 Skill tool calls'), explicit fail-closed ('return SKIP_POST,
do not draft from memory'). Used in tandem with code-side skill-gate
audit in PostGenerationAgent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Add Step 0 to `grammar-reviewer.md` (flip fail-closed)

**Files:**
- Modify: `apps/automation/.claude/agents/grammar-reviewer.md`

- [ ] **Step 1: Replace the existing skill-loading block**

Open `apps/automation/.claude/agents/grammar-reviewer.md`. Find:
```
## Required skill loading — do this FIRST
For every name in `skills`, invoke `Skill(<name>)` and read its full contents. Only after all
skills are loaded may you start editing.

If any skill fails to load, return the draft unchanged (fail-open — do not make it worse).
```

Replace with:
```markdown
## Step 0 — Skill loading (MANDATORY, BEFORE ANYTHING ELSE)
The user message contains a `skills` array, e.g.
`["grammar-ua", "anti-slop", "channel-X"]`.

You MUST invoke `Skill(<name>)` for EVERY entry in that array. This is non-negotiable.
Emit one tool call per skill — in any order — BEFORE editing the draft.

If any `Skill` call fails, your response MUST be the literal string `SKIP_POST` and
nothing else. (Fail-closed — a reviewer that silently skips its checks is worse than
no post; the strategy will retry on next cron.)

Only after all `Skill` calls have completed may you edit the draft.
```

- [ ] **Step 2: Verify section order**

Run:
```bash
grep -E "^## " apps/automation/.claude/agents/grammar-reviewer.md
```

Expected: `## Input`, `## Step 0 — Skill loading (MANDATORY, BEFORE ANYTHING ELSE)`,
`## Fix`, `## Strip`, `## Do NOT change`, `## Final self-audit — mandatory`, `## Output`.

- [ ] **Step 3: Commit**

```bash
git add apps/automation/.claude/agents/grammar-reviewer.md
git commit -m "feat(agents): grammar-reviewer Step 0 + fail-closed

Flips skill-load failure from fail-open (return draft unchanged) to
fail-closed (return SKIP_POST). Trade-off: a transient skill load
error blocks a single post until next cron rather than shipping a
partly-reviewed draft. Acceptable given the silent-quality-failure
rate today.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Add Step 0 to `skill-planner.md` and `tag-generator.md`

**Files:**
- Modify: `apps/automation/.claude/agents/skill-planner.md`
- Modify: `apps/automation/.claude/agents/tag-generator.md`

- [ ] **Step 1: Update `skill-planner.md`**

Open `apps/automation/.claude/agents/skill-planner.md`. Locate the existing `## Task` section.
Above it (after `## Input`), insert a new section:

```markdown
## Step 0 — Skill loading (MANDATORY, BEFORE ANYTHING ELSE)
You MUST invoke `Skill(<channelSkill>)` first, before deciding the plan.

If the call fails, output exactly:
```
{"writerSkills":[],"reviewerSkills":[],"notes":"channel skill failed to load"}
```
…and nothing else.
```

Then in `## Task` step 1 (which currently reads "Invoke `Skill(<channelSkill>)`…"), keep the
text but add a leading sentence: `Already done in Step 0. Use what you read there to:`.

- [ ] **Step 2: Update `tag-generator.md`**

Open `apps/automation/.claude/agents/tag-generator.md`. Locate the existing `## Required skill
loading — do this FIRST` section. Replace its body with:

```markdown
## Step 0 — Skill loading (MANDATORY, BEFORE ANYTHING ELSE)
You MUST invoke `Skill(<channelSkill>)` first, before picking a tag.

If the call fails or returns an error, your response MUST be the literal string `none`
and nothing else.
```

Keep the section heading style consistent — replace the old `## Required skill loading
— do this FIRST` heading text with `## Step 0 — Skill loading (MANDATORY, BEFORE ANYTHING ELSE)`.

- [ ] **Step 3: Verify both files**

Run:
```bash
grep -E "^## " apps/automation/.claude/agents/skill-planner.md
grep -E "^## " apps/automation/.claude/agents/tag-generator.md
```

Expected for skill-planner: `## Input`, `## Step 0 — Skill loading (MANDATORY, BEFORE ANYTHING ELSE)`,
`## Task`, `## Default skill set (use unless the channel skill explicitly overrides)`,
`## Output — strict JSON, no prose`, `## Rules`.

Expected for tag-generator: `## Input`, `## Step 0 — Skill loading (MANDATORY, BEFORE ANYTHING ELSE)`,
`## Task`, `## Rules`, `## Output`.

- [ ] **Step 4: Commit**

```bash
git add apps/automation/.claude/agents/skill-planner.md \
        apps/automation/.claude/agents/tag-generator.md
git commit -m "feat(agents): skill-planner + tag-generator Step 0

Same mandatory Skill(<channelSkill>) step prepended to both. Provides
a deterministic channel-skill load even on the smallest subagents,
which the code-side skill-gate audits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Type-check, run helper tests, smoke test

**Files:** none (verification only)

- [ ] **Step 1: Full TypeScript check**

Run:
```bash
cd apps/automation && npx tsc -p tsconfig.json --noEmit
```

Expected: no errors. If errors appear, fix them in the relevant file before continuing.

- [ ] **Step 2: Run helper tests**

Run from repo root:
```bash
npx tsx --test apps/automation/src/common/ai/post-generation.helpers.test.ts
```

Expected: `# pass 19`, `# fail 0`, exit 0.

- [ ] **Step 3: Smoke run — news mode (`ai0-news`)**

Start the automation service in dev mode (or trigger the admin `/run` command) and dispatch
a single `ai0-news` cycle. Capture stdout for ~2 minutes.

Run:
```bash
pnpm dev:automation 2>&1 | tee /tmp/smoke-news.log &
# In another shell, send /run ai0-news via the admin bot, OR wait for the cron
# Then stop after one full cycle:
sleep 180; pkill -f 'nest start' || true
```

Inspect:
```bash
grep -E '\[main-news-agent\]\s+(→|←|Skill\()' /tmp/smoke-news.log
```

Expected lines (exact subagent names, exact order):
```
[main-news-agent] → skill-planner (xxxxxxxx)
[main-news-agent]   Skill(channel-ai0-news) ← skill-planner
[main-news-agent] ← skill-planner (xxxxxxxx): ok, NNN chars, NNNNms
[main-news-agent] → post-writer (yyyyyyyy)
[main-news-agent]   Skill(human-voice) ← post-writer
[main-news-agent]   Skill(anti-slop) ← post-writer
[main-news-agent]   Skill(channel-ai0-news) ← post-writer
[main-news-agent] ← post-writer (yyyyyyyy): ok, NNN chars, NNNNms
[main-news-agent] → grammar-reviewer (zzzzzzzz)
[main-news-agent]   Skill(grammar-ua) ← grammar-reviewer
[main-news-agent]   Skill(anti-slop) ← grammar-reviewer
[main-news-agent]   Skill(channel-ai0-news) ← grammar-reviewer
[main-news-agent] ← grammar-reviewer (zzzzzzzz): ok, NNN chars, NNNNms
```

If `Skill(...) ← post-writer` rows are missing or have count < 3, the prompt change in
Task 11 is not yet effective and the run will fail the code-side skill-gate. Re-read the
prompt and confirm the Step 0 wording is rendered exactly.

- [ ] **Step 4: Telegram check**

Open the @ai0_global Telegram channel. The post produced during step 3 must:
- Not start with `Ось готовий пост:`, `**Готовий пост:**`, `Пост:`, etc.
- Not contain `**bold**` markdown anywhere in the body.
- Not contain `---` separator lines.
- Render bold/italic via `<b>`/`<i>` (Telegram should display it formatted).

If any of these fail, capture the post text, search the latest `combined-*.log` for
`textSource` field, and verify whether `cleanFinalText` was actually applied (textSource
should be `stream` or `legacy-parse`, not `none`).

- [ ] **Step 5: Smoke run — simple mode**

Trigger any simple-mode strategy already migrated (e.g. `movies` or `recipes`) and verify
the same: skill-gate trace shows 3 Skill calls in `post-writer` and `grammar-reviewer`,
post lands clean in Telegram.

- [ ] **Step 6: Skip-path check**

Find an item that should produce `SKIP_POST` (paywall stub, broken HTML, or hand-craft a
test fixture with empty content) and verify:
- `combined-*.log` contains `status: 'skipped'`
- `published_posts` table got NO new row for that item
- `dedup` did mark the source so it won't re-process

- [ ] **Step 7: Commit a verification note**

If everything passes, no code commit is needed for this task — the implementation is
already committed. If smoke tests revealed prompt or code adjustments, commit those
under their respective files with a `fix:` prefix.

---

## Task 15: One-week soak monitoring (informational, not in this PR)

After this PR merges, monitor `/analyze` daily for one week:

- `% runs with textSource: 'stream'` should be ≥ 95%.
- `% runs with textSource: 'legacy-parse'` should be < 5% and trending toward 0.
- `% runs with status: 'error'` and `error: 'skill-gate failed'` should be < 5%.
- `% Telegram posts containing **` (manual sample 20 random posts/day) should be 0.

If after 7 days these hold, open a follow-up cleanup PR that:
- Removes `parseResult` and the deprecated `stripPreambles` from `post-generation.agent.ts`.
- Removes the `legacy-parse` branch in `generate()`.
- Removes `textSource: 'legacy-parse'` from the structured-log enum.

If any metric fails, open a fix PR addressing the specific symptom (likely a prompt tweak
on the misbehaving subagent).
