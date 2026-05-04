# Direct-API PostGenerationAgent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Replace `PostGenerationAgent.generate()` with a single-API-call implementation that uses `ClaudeAgent.chat()`. System prompt composed from `.claude/skills/*/SKILL.md` at runtime. HTTP fetch fallback for thin RSS content. Tag generation written but unused (RSS tags always present).

**Architecture:** Strategies call `generate()`. It optionally fetches the source URL if RSS content is thin, builds a per-channel system prompt by reading 4 skill `.md` files, makes one `ClaudeAgent.chat()` call, runs `cleanFinalText` defensively, returns `{text, tag}` (tag from RSS).

**Spec:** `docs/superpowers/specs/2026-05-05-direct-api-final.md`

---

## File map

**Modified:**
- `apps/automation/src/common/ai/post-generation.agent.ts` — full rewrite (chain logic out, single-call in).
- `apps/automation/src/common/ai/post-generation.helpers.ts` — keep `stripStrayMarkdown`/`stripPreambles`/`cleanFinalText`; delete `skillGatePassed` + `SkillGateResult` + `SKILL_GATE_THRESHOLDS`.
- `apps/automation/src/common/ai/post-generation.helpers.test.ts` — keep 19 tests; delete the 4 `skillGatePassed` tests (one of them is "passes with full set", three failure tests).

**Created:**
- `apps/automation/.claude/settings.json` — permissive permissions block.

**Deleted:**
- `apps/automation/.claude/agents/post-writer.md`
- `apps/automation/.claude/agents/grammar-reviewer.md`
- `apps/automation/.claude/agents/info-preparator.md`
- `apps/automation/.claude/agents/tag-generator.md`

**Unchanged:**
- `apps/automation/src/common/ai/agents/claude.agent.ts` (use as-is via DI).
- `apps/automation/.claude/skills/*/SKILL.md` (12 files — content source).
- `apps/automation/.claude/agents/topic-router.md`, `topic-novelty-checker.md`.
- Strategies, dedup, image, publishers, etc.
- `apps/automation/src/common/common.module.ts` — `PostGenerationAgent` already exported.

---

## Task 1: Drop `skillGatePassed` from helpers + tests

**Files:**
- Modify: `apps/automation/src/common/ai/post-generation.helpers.ts`
- Modify: `apps/automation/src/common/ai/post-generation.helpers.test.ts`

- [ ] **Step 1: Delete from helpers.ts**

In `apps/automation/src/common/ai/post-generation.helpers.ts`, delete:
- The `SkillGateResult` interface and its JSDoc.
- The `SKILL_GATE_THRESHOLDS` constant and its JSDoc.
- The `skillGatePassed` function and its JSDoc.

Keep `stripStrayMarkdown`, `stripPreambles`, `cleanFinalText` — they continue to be used.

- [ ] **Step 2: Delete tests**

In `apps/automation/src/common/ai/post-generation.helpers.test.ts`, delete the 4 tests whose names start with `skillGatePassed:`. Remove the `skillGatePassed` import line if it imports only the gate (otherwise reduce the import).

- [ ] **Step 3: Run tests**

```bash
npx tsx --test apps/automation/src/common/ai/post-generation.helpers.test.ts
```

Expected: `# pass 18`, `# fail 0`. (Was 22; minus 4 deleted tests = 18.)

- [ ] **Step 4: TypeScript compiles**

```bash
cd apps/automation && npx tsc -p tsconfig.json --noEmit
```

Expected: clean. If you see "Cannot find name 'skillGatePassed'" or similar, you missed a reference in `post-generation.agent.ts` — `generate()` is going to be rewritten in Task 4 anyway, so for now you can leave the import + call in the agent file untouched (it'll be removed in Task 4). Actually best path: comment-out/remove the `skillGatePassed` import + call from `post-generation.agent.ts` here as well, in this same commit, to keep TS green between commits. **Do this**: open `post-generation.agent.ts`, find the import line `import { ..., skillGatePassed } from './post-generation.helpers';`, remove `skillGatePassed`. Find any reference to `skillGatePassed(` in the file — there shouldn't be any in current state because the chain step 5 commit (5a5b39b) replaced planner with TS lookup, but verify with `grep -n skillGatePassed apps/automation/src/common/ai/post-generation.agent.ts`. Fix as needed.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/common/ai/post-generation.helpers.ts \
        apps/automation/src/common/ai/post-generation.helpers.test.ts \
        apps/automation/src/common/ai/post-generation.agent.ts
git commit -m "refactor(ai): drop skillGatePassed (unused after direct-API pivot)

Single-API-call architecture has no per-step skill gate. Quality is
enforced by the system prompt now. Helpers file shrinks by one
function + interface + threshold const. 4 tests deleted (test count
22 → 18). Agent file's stray import (if any) cleaned up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add `apps/automation/.claude/settings.json`

**Files:**
- Create: `apps/automation/.claude/settings.json`

- [ ] **Step 1: Create the file**

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

- [ ] **Step 2: Commit**

```bash
git add apps/automation/.claude/settings.json
git commit -m "chore: permissive Claude settings for autonomous flows

apps/automation runs cron-driven; permission prompts must not block.
This settings file sits next to .claude/skills and .claude/agents and
applies to any residual Claude SDK calls in the project.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Delete chain-era subagent .md files

**Files:**
- Delete: `apps/automation/.claude/agents/post-writer.md`
- Delete: `apps/automation/.claude/agents/grammar-reviewer.md`
- Delete: `apps/automation/.claude/agents/info-preparator.md`
- Delete: `apps/automation/.claude/agents/tag-generator.md`

(`skill-planner.md`, `main-news-agent.md`, `main-simple-agent.md` were already deleted earlier on this branch.)

- [ ] **Step 1: Delete all four files**

```bash
rm apps/automation/.claude/agents/post-writer.md
rm apps/automation/.claude/agents/grammar-reviewer.md
rm apps/automation/.claude/agents/info-preparator.md
rm apps/automation/.claude/agents/tag-generator.md
```

- [ ] **Step 2: Confirm no source references**

```bash
grep -rn "post-writer\|grammar-reviewer\|info-preparator\|tag-generator" apps/automation/.claude/ apps/automation/src/ 2>/dev/null
```

Expected matches:
- References inside `apps/automation/src/common/ai/post-generation.agent.ts` will be removed in Task 4.
- `apps/automation/.claude/agents/topic-router.md` and `topic-novelty-checker.md` should NOT mention these (those are for a different pipeline).

If any unexpected hits, flag and stop.

- [ ] **Step 3: Commit**

```bash
git add -u apps/automation/.claude/agents/post-writer.md \
           apps/automation/.claude/agents/grammar-reviewer.md \
           apps/automation/.claude/agents/info-preparator.md \
           apps/automation/.claude/agents/tag-generator.md
git commit -m "feat(agents): delete chain-era subagent .md files

Remaining residual files from the abandoned chain-of-prompts approach.
Direct-API pivot uses .claude/skills/*/SKILL.md as system-prompt
content sources directly — no agent-as-subagent layer needed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Rewrite `PostGenerationAgent` for direct-API single-call

**Files:**
- Modify: `apps/automation/src/common/ai/post-generation.agent.ts`

This is the central change. Replace the chain implementation with a single-call shape. Read `claude.agent.ts` first to understand the existing `ClaudeAgent.chat()` API.

- [ ] **Step 1: Read `claude.agent.ts` for the `chat()` signature**

The existing wrapper (kept unchanged) takes `(messages: AiChatMessage[], options?: { model?, maxTokens? })` and returns `Promise<string | null>`. Use it.

- [ ] **Step 2: Rewrite `post-generation.agent.ts` end-to-end**

Open the file. Replace its entire contents (preserving the file path) with:

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'fs/promises';
import { join } from 'path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { ClaudeAgent } from './agents/claude.agent';
import { cleanFinalText } from './post-generation.helpers';

export type PostMode = 'news' | 'simple';

export interface GenerateInput {
  /** Pipeline variant — news mode triggers HTTP fetch fallback for thin content. */
  mode:             PostMode;
  /** Skill name to apply, e.g. 'channel-ai0-news'. Must match a folder in apps/automation/.claude/skills/. */
  channelSkill:     string;
  /** Strategy-specific raw data: { title, content, source, tags? }. */
  rawData:          Record<string, unknown>;
  /** Force HTTP fetch fallback even if content looks long enough. */
  needsEnrichment?: boolean;
}

export interface GeneratedPost {
  /** Finished post text (no tag line, no source link). */
  text: string;
  /** Single tag word (RSS-provided in production), without '#'. Empty string if absent. */
  tag:  string;
}

/**
 * PostGenerationAgent — single API call per post.
 *
 * Flow:
 *   1. Optionally HTTP-fetch the source URL if rawData.content is thin.
 *   2. Compose a per-channel system prompt from .claude/skills/*.md.
 *   3. One ClaudeAgent.chat() call. Output is the post body.
 *   4. cleanFinalText defensive cleanup + length guard.
 *   5. Tag from rawData.tags[0] (RSS-provided in production).
 *
 * No subagents. No tool calls. No chain. Quality is enforced by the system prompt.
 */
@Injectable()
export class PostGenerationAgent implements OnModuleInit {
  private readonly logger = new Logger(PostGenerationAgent.name);

  /** Resolves to apps/automation/ at runtime — the folder containing .claude/. */
  private cwd!: string;

  /** Skip if even after URL fetch we have less than this many chars. */
  private readonly MIN_CONTENT_CHARS = 400;

  constructor(
    private readonly config: ConfigService,
    private readonly claude: ClaudeAgent,
  ) {}

  onModuleInit() {
    this.cwd = join(__dirname, '..', '..', '..');
  }

  async generate(input: GenerateInput): Promise<GeneratedPost | 'SKIP_POST' | null> {
    const start = Date.now();
    const raw = input.rawData as { title?: string; content?: string; source?: string; tags?: string[] };

    // Step 0: ensure we have content; HTTP fetch fallback for thin RSS items.
    let content = raw.content ?? '';
    if (input.needsEnrichment || content.length < this.MIN_CONTENT_CHARS) {
      const fetched = raw.source ? await this.maybeFetchUrl(raw.source) : null;
      if (fetched && fetched.length > content.length) content = fetched;
    }
    if (content.length < this.MIN_CONTENT_CHARS) {
      this.logger.warn(`[generate] content too thin (${content.length} chars) — skipping`);
      return null;
    }

    // Step 1: single API call.
    const system = await this.buildSystemPrompt(input.channelSkill);
    const user   = this.buildUserMessage({ ...raw, content });

    const result = await this.claude.chat(
      [
        { role: 'system', content: system },
        { role: 'user',   content: user   },
      ],
      {
        model:     this.config.get<string>('POST_GEN_MODEL') ?? 'claude-sonnet-4-6',
        maxTokens: 1500,
      },
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

    // Step 3: tag from RSS.
    const tag = raw.tags?.[0] ?? '';

    this.logger.debug(`[generate] success ${cleaned.length} chars in ${Date.now() - start}ms`);
    return { text: cleaned, tag };
  }

  /**
   * Composes a per-channel system prompt by reading and concatenating four
   * .claude/skills/<name>/SKILL.md files. Strips YAML frontmatter from each.
   */
  private async buildSystemPrompt(channelSkill: string): Promise<string> {
    const [channelMd, voiceMd, antiSlopMd, grammarMd] = await Promise.all([
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
      channelMd,
      ``,
      `# HUMAN VOICE`,
      voiceMd,
      ``,
      `# ANTI-SLOP`,
      antiSlopMd,
      ``,
      `# GRAMMAR & ORTHOGRAPHY (Ukrainian)`,
      grammarMd,
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
    try {
      const raw = await readFile(path, 'utf8');
      return raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    } catch (err: any) {
      this.logger.warn(`[readSkill] failed to read ${path}: ${err.message}`);
      return '';
    }
  }

  private buildUserMessage(raw: { title?: string; content?: string; source?: string; tags?: string[] }): string {
    return [
      raw.source ? `Source URL: ${raw.source}` : '',
      raw.tags?.length ? `Source tags: ${raw.tags.join(', ')}` : '',
      raw.title ? `Original title: ${raw.title}` : '',
      ``,
      `Content:`,
      raw.content ?? '',
    ].filter((s) => s !== undefined).join('\n');
  }

  /**
   * Plain HTTP fallback for thin RSS content — fetches the source URL and
   * extracts <article>/<main>/<body> text. No AI involved.
   */
  private async maybeFetchUrl(url: string): Promise<string | null> {
    if (!url) return null;
    try {
      const res = await axios.get<string>(url, {
        timeout: 10_000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ai0-global/1.0)' },
        responseType: 'text',
        validateStatus: (s) => s >= 200 && s < 400,
      });
      const $ = cheerio.load(res.data);
      const text = ($('article').text() || $('main').text() || $('body').text()).replace(/\s+/g, ' ').trim();
      return text.length > 200 ? text.slice(0, 8000) : null;
    } catch (err: any) {
      this.logger.debug(`[maybeFetchUrl] ${url}: ${err.message}`);
      return null;
    }
  }

  /**
   * Tag-generation utility. Not called from generate() in production
   * because RSS items always carry tags. Provided for one-off use.
   */
  async maybeGenerateTag(post: string, channelSkill: string): Promise<string> {
    const skillContent = await this.readSkill(channelSkill);
    const tagLineMatch = skillContent.match(/Allowed tag(?:\s+vocabulary)?[\s\S]*?:([^\n]+)/i);
    const allowed = tagLineMatch?.[1]?.trim() ?? '';

    const result = await this.claude.chat(
      [
        {
          role:    'system',
          content: `Pick exactly ONE topical tag for this Ukrainian Telegram post. Output a single lowercase Latin word, no '#', no quotes, no punctuation.${allowed ? ` Allowed list: ${allowed}` : ''} If nothing fits or post is empty, output: none`,
        },
        { role: 'user', content: post },
      ],
      { model: 'claude-haiku-4-5-20251001', maxTokens: 16 },
    );

    if (!result) return '';
    const word = result.toLowerCase().trim().replace(/^[`'"#\s]+|[`'"\s]+$/g, '').match(/[a-z0-9_]+/)?.[0] ?? '';
    if (!word || word === 'none' || word.length > 24) return '';
    return word;
  }
}
```

- [ ] **Step 3: Verify `cheerio` is installed**

```bash
grep -E '"cheerio"' apps/automation/package.json
```

If missing, install:
```bash
pnpm --filter automation add cheerio
```

If already present (likely — used by image-resolver and other places), no action.

- [ ] **Step 4: Verify `axios` is installed**

```bash
grep -E '"axios"' apps/automation/package.json
```

Expected: present (broadly used).

- [ ] **Step 5: TypeScript compiles**

```bash
cd apps/automation && npx tsc -p tsconfig.json --noEmit
```

Expected: clean. Common errors:
- `Cannot find module 'cheerio'` → install
- `ClaudeAgent` import path wrong → verify `./agents/claude.agent`
- `cleanFinalText` import path wrong → verify `./post-generation.helpers`

- [ ] **Step 6: Helper tests still pass**

```bash
npx tsx --test apps/automation/src/common/ai/post-generation.helpers.test.ts
```

Expected: `# pass 18`, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add apps/automation/src/common/ai/post-generation.agent.ts
git commit -m "refactor(ai): single-API-call PostGenerationAgent

Replaces the chain-of-prompts implementation (and its earlier
orchestrator predecessor) with a single ClaudeAgent.chat() call per
post. The system prompt is composed at runtime by reading four
.claude/skills/*/SKILL.md files (channel + human-voice + anti-slop
+ grammar-ua), stripping YAML frontmatter, and concatenating as
labelled sections. Quality is enforced by the system prompt — no
per-step gate, no review subagent leaking review-prose into the
body.

Includes:
- maybeFetchUrl plain HTTP fallback for thin RSS content (axios +
  cheerio extract <article>/<main>/<body>; no AI).
- maybeGenerateTag utility (claude-haiku-4-5, ~16 tokens output) —
  written but NOT called by generate(). Production uses RSS tags
  directly from rawData.tags[0]. Available for future use.

Cost/latency: ~5x cheaper, ~5x faster than the chain.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Smoke verification

**Files:** none (verification only)

User runs the dev server.

- [ ] **Step 1: Type-check + helper tests** (controller can run these)

```bash
cd /Users/tupotavalentyn/CS/ai0_global
cd apps/automation && npx tsc -p tsconfig.json --noEmit && cd ..
npx tsx --test apps/automation/src/common/ai/post-generation.helpers.test.ts
```

Expected: tsc clean, 18 tests pass.

- [ ] **Step 2: Smoke run** (user runs)

```bash
lsof -ti:3000 | xargs kill -9 2>/dev/null
pnpm dev:automation 2>&1 | tee /tmp/smoke-direct.log
# wait one cron cycle (~5 min)
# Ctrl+C
grep -E '\[(generate|PostGenerationAgent|Ai0NewsStrategy|UaNewsStrategy)\]' /tmp/smoke-direct.log | head -40
```

Expected:
- `[generate] success NNN chars in MMMms` (single call, no skill traces)
- A real Telegram post in @ai0_global with no `**bold**`, no `Готовий пост:`, no `## Рев'ю`, no `---`, no markdown headers.
- Latency per post under 15 seconds (vs ~80s in chain).

- [ ] **Step 3: Telegram check** (user)

Manually inspect 2-3 posts in @ai0_global / ua-news channels.

- [ ] **Step 4: If smoke surfaces issues**, fix under `fix(ai):` commits on this branch.

---

## Task 6: Final review + finishing branch

**Files:** none.

- [ ] Dispatch a final code-quality review on the branch (since baseline `6dcdb88`).
- [ ] Address any blocking issues.
- [ ] Use `superpowers:finishing-a-development-branch` to decide merge / PR / cleanup.
