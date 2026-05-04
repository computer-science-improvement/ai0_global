# Direct-API PostGenerationAgent — Final Design

**Supersedes:** the orchestrator-with-stream-capture (`2026-05-01-subagent-skill-gate-design.md`) and chain-of-prompts (`2026-05-04-chain-of-prompts-pivot.md`) approaches. Both relied on `@anthropic-ai/claude-agent-sdk` and produced unreliable post quality.

## Why pivoting again

Smoke evidence on the chain-of-prompts implementation (commit `5a5b39b`):

- Pipeline runs end-to-end. Skills load. Posts publish.
- BUT the published posts contain `## Рев'ю` headers, numbered correction lists, "## Фінальний текст" markers, and meta-commentary tables — the grammar-reviewer's review-process leaked into the body.
- The user's prior project, using plain `@anthropic-ai/sdk` with a single API call per post, produced cleaner output despite "less powerful" architecture.

Root causes of the agentic-SDK approach producing worse output:

1. **Agent SDK is optimised for tool-using/agentic workflows**, not prose generation. Each subagent layer is a place where the model can drift from the task ("write a Ukrainian post") to a meta-task ("act as a reviewer", "decide a plan").

2. **Skills loaded as tool results have weaker signal than skills baked into a system prompt**. Each subagent has its own role-framing prose competing with the actual style rules.

3. **The "reviewer" role inevitably produces review-style output** (analysis + corrections + final), regardless of "output only the corrected text" instructions. The model honours its role frame more strongly than its output instructions.

4. **Cumulative latency and cost**: 3-4 query() calls per post (~30-50s, ~$0.10-0.20) vs single-call (~5-10s, ~$0.02-0.05).

## New architecture: single API call per post

```
strategy
  ↓
PostGenerationAgent.generate({ mode, channelSkill, rawData, needsEnrichment })
  ↓
  ┌─────────────────────────────────────────────────────────────────────┐
  │ Step 0 (data, not AI): if rawData.content is thin (< MIN chars),     │
  │   try fetching rawData.source via existing axios/cheerio.            │
  │   If still thin: SKIP (return null, retry next cron).                │
  ├─────────────────────────────────────────────────────────────────────┤
  │ Step 1: ClaudeAgent.chat() — ONE API call                            │
  │   system: composed from .claude/skills/{channel,human-voice,         │
  │           anti-slop,grammar-ua}/SKILL.md                             │
  │   user:   `Source URL: …\nTags: …\nTitle: …\n\n<content>`            │
  │   model:  claude-sonnet-4-6 (configurable)                           │
  │   max_tokens: 1500                                                   │
  │   → final post body text                                             │
  ├─────────────────────────────────────────────────────────────────────┤
  │ Step 2 (data, not AI): cleanFinalText defensive cleanup              │
  │   strip preambles, markdown bold, --- separators                     │
  │   length guard: < 80 chars after HTML strip → null                   │
  ├─────────────────────────────────────────────────────────────────────┤
  │ Step 3 (data first, AI fallback unused): tag                         │
  │   tag = rawData.tags?.[0] ?? '' (RSS-provided in production)         │
  │   maybeGenerateTag() helper exists for one-off use but is not        │
  │   called in the production path.                                     │
  └─────────────────────────────────────────────────────────────────────┘
  ↓
  return { text: cleaned, tag } | 'SKIP_POST' | null
```

### Properties

- **One API call per post.** No tool dispatches. No subagent recursion. No chain.
- **System prompt is a single coherent document** — channel rules + voice + anti-slop + grammar all baked in.
- **Model only sees its actual task** (rewrite this article into a Ukrainian Telegram post). No role-framing as "reviewer" or "planner".
- **Data first, AI second.** Source URL, RSS tags, image — all from rawData. AI only generates what cannot be looked up.
- **Pure-function cleanup helpers** (`cleanFinalText`) survive from prior work — keep their 22 unit tests.
- **Configurable model.** Default `claude-sonnet-4-6` (good prose quality). Strategies can override per-channel if needed.

### What is kept from prior work

- `apps/automation/src/common/ai/post-generation.helpers.ts` — `stripStrayMarkdown`, `stripPreambles`, `cleanFinalText`. (`skillGatePassed` becomes dead — Task 6 deletes it.)
- `apps/automation/src/common/ai/post-generation.helpers.test.ts` — 19 of 22 tests stay (3 skill-gate tests deleted with the function).
- `apps/automation/.claude/skills/*/SKILL.md` — 12 skill files. **Critical** — they are the source of truth for system-prompt composition.
- `apps/automation/src/common/ai/agents/claude.agent.ts` — the existing `ClaudeAgent.chat()` wrapper around `@anthropic-ai/sdk`.
- Strategy infra: fetchers, dedup, image-resolver, publishers — untouched.
- Telemetry hook (`StructuredLoggerService.aiResponse` already used by `ClaudeAgent.chat`).
- `topic-router.md` and `topic-novelty-checker.md` agent files — separate pipeline, not in scope.

### What is removed

- `apps/automation/.claude/agents/post-writer.md`
- `apps/automation/.claude/agents/grammar-reviewer.md`
- `apps/automation/.claude/agents/info-preparator.md`
- `apps/automation/.claude/agents/tag-generator.md`
- (`skill-planner.md` and the `main-*-agent.md` orchestrators were already deleted on this branch.)
- `runSubagent`, `runTagGenerator` (chain version), `parsePlannerJson`, `logRunSummary`, `failChain`, `PerStepSummary`, `SubagentRunResult`, `RunCapture` — all chain-era code in `post-generation.agent.ts`.
- `CHANNEL_SKILL_PLAN` constant — only the skill names per channel are used now, baked into the system prompt builder.
- `skillGatePassed` helper + 3 tests — no per-step gate in single-call mode.
- `@anthropic-ai/claude-agent-sdk` import (the package stays installed in case `topic-router` or future code uses it; just no imports from `post-generation.agent.ts`).

## Components

### `buildSystemPrompt(channelSkill: string): Promise<string>`

Reads four `.claude/skills/<name>/SKILL.md` files at runtime, strips YAML frontmatter, concatenates as labelled sections, and returns the system prompt.

```ts
private async buildSystemPrompt(channelSkill: string): Promise<string> {
  const sections = await Promise.all([
    this.readSkill(channelSkill),
    this.readSkill('human-voice'),
    this.readSkill('anti-slop'),
    this.readSkill('grammar-ua'),
  ]);

  return [
    `# ROLE`,
    `You write a single Ukrainian-language Telegram post body. Output ONLY the post text — no preamble, no JSON, no markdown headers, no review notes, no "Фінальний текст" markers, nothing else.`,
    ``,
    `# CHANNEL RULES`,
    sections[0],
    ``,
    `# HUMAN VOICE`,
    sections[1],
    ``,
    `# ANTI-SLOP`,
    sections[2],
    ``,
    `# GRAMMAR & ORTHOGRAPHY (Ukrainian)`,
    sections[3],
    ``,
    `# OUTPUT FORMAT`,
    `- Telegram HTML only: <b>, <i>, <a href="...">, <code>, <u>.`,
    `- Max 850 characters total (Telegram caption limit minus our hashtag/source line). Birthday-story channel: 600–1100.`,
    `- No source links in the body — NestJS appends one separately.`,
    `- No hashtags in the body — NestJS appends one separately.`,
    `- No markdown bold (**), no markdown headers (##/###), no horizontal rules (---).`,
    ``,
    `# SKIP SIGNAL`,
    `If the source is unusable (paywall stub, broken HTML, obvious spam, empty content), output the literal three-letter string SKIP_POST and nothing else.`,
  ].join('\n');
}

private async readSkill(name: string): Promise<string> {
  const path = join(this.cwd, '.claude', 'skills', name, 'SKILL.md');
  const raw  = await readFile(path, 'utf8');
  // Strip YAML frontmatter: --- ... ---
  return raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}
```

`this.cwd` resolves to `apps/automation/` at runtime (matches existing post-generation.agent.ts behaviour).

### `generate(input: GenerateInput): Promise<GeneratedPost | 'SKIP_POST' | null>`

```ts
async generate(input: GenerateInput): Promise<GeneratedPost | 'SKIP_POST' | null> {
  const start = Date.now();

  // Step 0: ensure we have content; HTTP fetch fallback for thin RSS items.
  let content = (input.rawData as any).content as string ?? '';
  if (content.length < this.MIN_CONTENT_CHARS) {
    const fetched = await this.maybeFetchUrl((input.rawData as any).source);
    if (fetched && fetched.length > content.length) content = fetched;
  }
  if (content.length < this.MIN_CONTENT_CHARS) {
    this.logger.warn(`[generate] content too thin (${content.length} chars) — skipping`);
    return null;
  }

  // Step 1: single API call.
  const system = await this.buildSystemPrompt(input.channelSkill);
  const user   = this.buildUserMessage({ ...(input.rawData as any), content });

  const result = await this.claude.chat(
    [
      { role: 'system', content: system },
      { role: 'user',   content: user   },
    ],
    { model: this.config.get<string>('POST_GEN_MODEL') ?? 'claude-sonnet-4-6', maxTokens: 1500 },
  );

  if (!result) {
    this.logger.warn(`[generate] Claude returned null`);
    return null;
  }

  if (result.trim() === 'SKIP_POST') {
    this.logger.debug(`[generate] SKIP_POST signal`);
    return 'SKIP_POST';
  }

  // Step 2: defensive cleanup + length guard.
  const cleaned = cleanFinalText(result);
  if (cleaned.replace(/<[^>]+>/g, '').trim().length < 80) {
    this.logger.warn(`[generate] post too short after clean (${cleaned.length} chars) — treating as failure`);
    return null;
  }

  // Step 3: tag from RSS (production); maybeGenerateTag exists but is not called here.
  const tag = (input.rawData as any).tags?.[0] ?? '';

  this.logger.debug(`[generate] success ${cleaned.length} chars in ${Date.now() - start}ms`);
  return { text: cleaned, tag };
}
```

### `maybeFetchUrl(url: string): Promise<string | null>`

A small helper using the existing axios + (optional) cheerio infra. Fetches the URL, extracts `<article>` text or falls back to `<main>` then `<body>`. Plain code, no AI. Returns the extracted text or null if fetch failed.

```ts
private async maybeFetchUrl(url: string): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await axios.get(url, {
      timeout: 10_000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ai0-global/1.0)' },
    });
    const $ = cheerio.load(res.data);
    const text = ($('article').text() || $('main').text() || $('body').text()).trim();
    return text.length > 200 ? text.slice(0, 8000) : null;
  } catch (err: any) {
    this.logger.debug(`[maybeFetchUrl] ${url}: ${err.message}`);
    return null;
  }
}
```

`MIN_CONTENT_CHARS` defaults to 400 (configurable via env).

### `maybeGenerateTag(post: string, channelSkill: string): Promise<string>`

Written as a utility but **not called from `generate()` in production** (RSS tags are always present). Provided for future use:

```ts
async maybeGenerateTag(post: string, channelSkill: string): Promise<string> {
  const skillContent = await this.readSkill(channelSkill);
  const tagLine = skillContent.match(/Allowed tag vocabulary[\s\S]*?:([^\n]+)/i)?.[1] ?? '';

  const result = await this.claude.chat(
    [
      { role: 'system', content: `Pick exactly ONE topical tag from this allowed list (lowercase Latin, single word, no '#', no quotes): ${tagLine}\nIf nothing fits or post is empty, output: none` },
      { role: 'user',   content: post },
    ],
    { model: 'claude-haiku-4-5-20251001', maxTokens: 16 },
  );

  if (!result) return '';
  const cleaned = cleanTag(result);
  return cleaned;
}
```

`cleanTag` is the existing private method; might be moved into helpers for reuse.

### `.claude/settings.json`

Create `apps/automation/.claude/settings.json` with permissive permissions for any residual Agent SDK usage (e.g. `topic-router` if it ever runs via SDK):

```json
{
  "permissions": {
    "allow": [
      "Bash(*)",
      "Read(*)",
      "WebFetch",
      "WebSearch",
      "Skill(*)",
      "Agent(*)",
      "Edit(*)",
      "Write(*)"
    ]
  },
  "autoApprove": true
}
```

(Exact schema follows Claude Code project-settings convention; the goal is "no permission prompts in any flow that uses any Claude SDK".)

## Error handling

| Scenario | Detection | Action |
|---|---|---|
| Claude returns null (API error / no key) | `chat()` returns null | log + null (strategy retries) |
| Claude returns "SKIP_POST" | exact string after trim | return 'SKIP_POST' (strategy marks dedup) |
| Result < 80 chars after clean | length guard | log + null |
| Content < MIN_CONTENT_CHARS even after URL fetch | step 0 guard | log + null |
| URL fetch throws | catch block | null returned by `maybeFetchUrl`, fallback to original content |

No skill-gate, no per-step rejection — single call either works or doesn't. Quality is enforced by the system prompt.

## Verification

1. `cd apps/automation && npx tsc -p tsconfig.json --noEmit` — clean.
2. `npx tsx --test apps/automation/src/common/ai/post-generation.helpers.test.ts` — 19 of the original 22 tests pass after deleting 3 skill-gate tests.
3. Smoke run `/run ai0-news`:
   - Single API call per post (no `[skill-planner]`, `[post-writer]`, `[grammar-reviewer]` debug lines).
   - Telegram post lacks `## Рев'ю`, `**bold**`, `Готовий пост:`, `---`.
4. Smoke run `/run ua-news` and one simple-mode strategy (e.g. movies) — same shape.
5. Manual sample: 5 posts from each channel, eyeball check by user — no review-style meta, no AI tells.
6. Cost dashboard: per-post cost should drop ~5x compared to chain-of-prompts smoke runs.

## Out of scope

- Migrating remaining strategies (movies, recipes, daily-photo, etc.) — they keep their existing `FormatterService`/`SummarizerService` paths until a follow-up PR. The `PostGenerationAgent` change is invoked only from `ai0-news` and `ua-news` strategies in this PR.
- Removing the `@anthropic-ai/claude-agent-sdk` package (still installed for any code that imports it; can be uninstalled in a follow-up).
- `topic-router` / `topic-novelty-checker` — separate flow, untouched.
- A "rate limiter" or "retry on 429" — `ClaudeAgent.chat()` already returns null on errors; strategy retries on next cron.
