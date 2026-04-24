# Post Generation via Claude Agent SDK — Design

## Context

Today, AI post generation across `apps/automation` strategies is built on plain system-prompt strings
(`common/ai/skills/*.ts`) wired through thin per-provider agents (`common/ai/agents/*.ts`) and
hand-coded prompt chains in `FormatterService`, `SummarizerService`, `ReviewAgent`. Each strategy
hardcodes its own pipeline: fetch → clean → summarize → format → (sometimes) review. Adding a step
means editing the strategy; skill reuse across channels is copy-paste.

We want to move the **AI transformation layer** onto `@anthropic-ai/claude-agent-sdk`:

- Subagents (`info-preparator`, `post-writer`, `grammar-reviewer`) become reusable **instruments**.
- A single **main agent** decides which subagents to invoke in which order based on strategy flags.
- Skills become auto-discovered markdown folders, not TypeScript constants.
- Strategies only pass in `{ channelSkill, rawData, needsEnrichment }` and get back final post text.

Non-goals:
- We do **not** move I/O (RSS, HTTP fetch, DB, Telegram publish, dedup, image resolution, structured
  logging) into the agent. Those stay in NestJS — the agent is a pure AI transformer.
- We do **not** migrate every strategy. DB-only strategies (quotes, facts, pdr-quiz, motivation-
  biography, ai0-prompts) keep their current path unchanged.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Strategy (NestJS)                                           │
│    fetch RSS / HTTP / DB → clean → dedup → resolve image     │
│    ↓                                                         │
│    PostGenerationAgent.generate({                            │
│      mode: 'news' | 'simple',                                │
│      channelSkill: 'channel-ai0-news',                       │
│      rawData: { title, content, source, tags },              │
│      needsEnrichment: true                                   │
│    })                                                        │
│    ↓ final post text (or 'SKIP_POST')                        │
│    publish to Telegram + mark in published_posts             │
└──────────────────────────────────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────┐
│  PostGenerationAgent — wraps @anthropic-ai/claude-agent-sdk  │
│    query({                                                   │
│      prompt: userMessage,                                    │
│      options: {                                              │
│        cwd: apps/automation,                                 │
│        settingSources: ['project'],    // .claude/skills +   │
│                                        // .claude/agents     │
│        allowedTools: ['Task'],         // no file/web tools  │
│        permissionMode: 'bypassPermissions'                   │
│      }                                                       │
│    })                                                        │
└──────────────────────────────────────────────────────────────┘
              ↓                ↓                  ↓
    ┌──────────────────┐ ┌─────────────┐ ┌────────────────────┐
    │ info-preparator  │ │ post-writer │ │  grammar-reviewer  │
    │ Sonnet           │ │ Haiku       │ │  Haiku             │
    │ Tools:           │ │ Tools: —    │ │  Tools: —          │
    │   WebFetch,      │ │ Skills:     │ │  Skills:           │
    │   WebSearch      │ │   human-    │ │    grammar-ua      │
    │ Skills: —        │ │   voice,    │ │                    │
    │                  │ │   anti-slop,│ │                    │
    │                  │ │   <channel> │ │                    │
    └──────────────────┘ └─────────────┘ └────────────────────┘
```

### Properties

- Single reusable service (`PostGenerationAgent`). Strategies pass flags; it picks main-agent variant.
- Subagents are markdown files under `apps/automation/.claude/agents/` — SDK auto-discovers via
  `settingSources: ['project']`.
- Skills are folders under `apps/automation/.claude/skills/<name>/SKILL.md` — auto-discovered same way.
- Main agent has `allowedTools: ['Task']` only — it cannot write the post itself, must delegate.
- News-class strategies pass `needsEnrichment: true` to unlock info-preparator path.
- Simple strategies use `main-simple-agent` which doesn't know info-preparator exists.

### Which strategies are in scope

| Strategy | Mode | Reason |
|---|---|---|
| `ai0-news` | `news` | Article enrichment + write + review |
| `ua-news` | `news` | Same as above |
| `on-this-day` | `news` | Historical-fact gathering benefits from info-preparator |
| `movies` | `simple` | Structured data from scraper → format + review |
| `space` | `simple` | APOD/NASA data → format + review |
| `daily-photo` | `simple` | Known image metadata → format + review |
| `recipes` | `simple` | Scraped recipe JSON → format + review |
| `birthday-story` | `simple` | DB entry → format + review |
| `game-channel` | `simple` | Known game data → format + review |
| `assets` | `simple` | Prompts-repository row → format + review |
| `quotes`, `facts`, `pdr-quiz`, `motivation-biography`, `ai0-prompts` | — | Not migrated. Pure DB-read, no AI transformation. |

## Subagents

All under `apps/automation/.claude/agents/`.

### `info-preparator.md`
```yaml
---
description: Gathers and structures source material for a post. Use when raw content is short, missing context, or needs fact enrichment from the web.
model: sonnet
tools: WebFetch, WebSearch
---

You prepare source material for a Ukrainian news post.

Input: raw article (title, content, source URL, tags).

Your job:
1. If content is < 800 chars OR missing key facts (numbers, names, dates) — use WebFetch on
   the source URL and WebSearch to fill gaps.
2. Extract a structured brief:
   - Core fact (what happened, one sentence)
   - Who/what is involved (names, companies)
   - Numbers (amounts, dates, percentages — only from sources)
   - Context (why it matters — one sentence max, only if sources state it)
   - Source URL (unchanged)

Never invent facts. If a number/name isn't in the source, omit it — don't guess.

Return the brief as plain text, sections labeled.
```

### `post-writer.md`
```yaml
---
description: Writes the final Ukrainian Telegram post from a structured brief. Always use this subagent to produce post text — never write posts directly.
model: haiku
tools: []
---

You write Ukrainian Telegram posts from a structured brief.

Apply these skills (auto-loaded): human-voice, anti-slop, and the channel-specific skill
passed in the brief (e.g. channel-ai0-news).

Rules:
- Max 900 characters total
- Telegram HTML only: <b>, <i>, <a href="...">, <code>
- One fact per sentence
- No emoji unless channel skill explicitly allows
- No "so what" commentary — facts only

Output: post text ready for Telegram. Nothing else — no preamble, no markdown code fences.
```

### `grammar-reviewer.md`
```yaml
---
description: Proofreads a finished Ukrainian post. Fixes grammar, awkward phrasing, AI-sounding sentences. Use after post-writer, before returning final text.
model: haiku
tools: []
---

You proofread Ukrainian Telegram posts.

Input: finished post text.

Fix:
- Grammar and spelling errors
- Wrong word choices, invented words, mistranslations
- AI-sounding phrases — rewrite as natural Ukrainian
- Awkward sentences

Do NOT change:
- Facts, numbers, prices, dates, URLs
- HTML tags and structure
- Proper nouns (companies, products, people, games)
- Post length — if anything, shorten. Never exceed 900 chars.

Output: corrected post text only. No explanations. If no errors, return as-is.
```

### `main-news-agent.md`
```yaml
---
description: Orchestrates Ukrainian news post generation. Dispatches to info-preparator, post-writer, grammar-reviewer subagents. Returns final post text only.
model: sonnet
tools: Task
---

You produce a single Ukrainian Telegram post from raw source material.

Subagents available via the Task tool:
- info-preparator  — enriches and structures source material
- post-writer      — writes the post from a brief
- grammar-reviewer — proofreads a finished post

## Sequence
1. If input says `needsEnrichment: true` OR raw content < 800 chars → dispatch info-preparator.
2. Dispatch post-writer with the brief + channel skill name.
3. Dispatch grammar-reviewer on the result.
4. Return ONLY the corrected post text. No preamble, no explanations.

## Skip signal
If the source is unusable (broken HTML, non-article page, paywall stub, obvious spam)
return the literal string `SKIP_POST` and nothing else.

## Channel context
The channel skill name is in the user message. You MUST tell post-writer which channel
skill to apply.
```

### `main-simple-agent.md`
```yaml
---
description: Produces a Ukrainian Telegram post from already-structured data (no enrichment). Dispatches post-writer then grammar-reviewer. Returns final post.
model: haiku
tools: Task
---

You produce a single Ukrainian Telegram post from structured input data.

Subagents:
- post-writer      — writes the post. Always use.
- grammar-reviewer — proofreads. Always use.

## Sequence
1. Dispatch post-writer with the input data + channel skill name.
2. Dispatch grammar-reviewer on the result.
3. Return the corrected post text. No preamble.

Never fetch or search — input is final. If input is empty or malformed, return `SKIP_POST`.
```

## Skills

All under `apps/automation/.claude/skills/`. Each is a folder with `SKILL.md` containing YAML
frontmatter + markdown body.

### Migration map

| Current TS file | New skill folder | Notes |
|---|---|---|
| `common/ai/skills/human-voice.skill.ts` | `skills/human-voice/` | Content preserved |
| `common/ai/skills/anti-slop.skill.ts`   | `skills/anti-slop/` | Content preserved |
| `common/ai/skills/review.skill.ts`      | `skills/grammar-ua/` + reviewer system prompt | Split: static rules → skill; action rules → subagent |
| `common/ai/skills/ai0-news-channel.skill.ts`   | `skills/channel-ai0-news/` | |
| `common/ai/skills/ua-news-channel.skill.ts`    | `skills/channel-ua-news/` | |
| `common/ai/skills/gaming-channel.skill.ts`     | `skills/channel-gaming/` | |
| `common/ai/skills/movies-channel.skill.ts`     | `skills/channel-movies/` | |
| `common/ai/skills/space-channel.skill.ts`      | `skills/channel-space/` | |
| `common/ai/skills/recipes-channel.skill.ts`    | `skills/channel-recipes/` | |
| `common/ai/skills/daily-photo-channel.skill.ts`| `skills/channel-daily-photo/` | |
| `common/ai/skills/birthday-story-channel.skill.ts` | `skills/channel-birthday-story/` | |
| `common/ai/skills/on-this-day-channel.skill.ts`| `skills/channel-on-this-day/` | |
| `common/ai/skills/skip-signal.skill.ts`        | *(merged into main-agent prompt)* | Instruction, not reusable skill |

Old `common/ai/skills/*.ts` and `common/ai/skills/skill.interface.ts` are deleted after migration
completes.

### `skills/human-voice/SKILL.md`
```yaml
---
description: Rules for human-sounding Ukrainian writing. Apply when writing or reviewing any Ukrainian post — turns AI-sounding text into natural prose.
---
```
Body: existing `HUMAN_VOICE_SKILL.instructions` content, re-headed as `# Human Voice — Ukrainian`.

### `skills/anti-slop/SKILL.md`
```yaml
---
description: Forbidden AI-tells in Ukrainian text. Apply when writing or reviewing posts — catches signature AI phrasings before they ship.
---
```
Body: existing `ANTI_SLOP_SKILL.instructions`.

### `skills/grammar-ua/SKILL.md` (new)
```yaml
---
description: Ukrainian grammar and orthography rules for proofreading posts. Apply only in grammar-review contexts, not during initial writing.
---

# Ukrainian Grammar — Proofread Checklist

## Common errors to fix
- Кличний відмінок in direct address (leave untouched in headlines/reports)
- Активні дієприкметники (-уч-/-юч-): "працюючий" → "який працює"
- Калькування: "приймати участь" → "брати участь", "на протязі" → "протягом"
- Зайве "являється": "він являється директором" → "він директор"
- Англіцизми з неправильною відмінковою формою

## Proper nouns — never translate
Company/product/person/platform/game names stay in original language.
- Good: "Apple випустила iOS 18"
- Bad: "Еппл випустила"

## Numbers and units
- "15%" not "15 %"
- "$8 млн" / "8 млрд грн"
- "12 березня 2026" (no year if current)
```

### Channel skills
Each keeps its current rules. Example (`skills/channel-ai0-news/SKILL.md`):
```yaml
---
description: Tone and style for the @ai0_global Telegram channel (tech/science/energy/sports, Ukrainian, journalistic neutral).
---

# ai0-news Channel

## Audience
Ukrainian readers interested in tech, science, energy, sports. Educated general audience.

## Tone
Journalistic and neutral. Report facts.
Avoid: "revolutionary", "game-changing", "unprecedented", promotional language.

## Language
Ukrainian throughout. Proper nouns in original form.
- Good: "Apple випустила iOS 18" / "Elon Musk заявив"
- Bad: "Еппл", "Елон Маск"

## Structure
One fact per sentence. Short paragraphs. No filler.
```
Other channel skills follow identical shape — description in frontmatter, rules in body.

## NestJS integration

### `PostGenerationAgent` service

Location: `apps/automation/src/common/ai/post-generation.agent.ts`.

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { join } from 'path';
import { StructuredLoggerService } from '../logging/structured-logger.service';

export type PostMode = 'news' | 'simple';

export interface GenerateInput {
  mode:            PostMode;
  channelSkill:    string;                   // e.g. 'channel-ai0-news'
  rawData:         Record<string, unknown>;  // strategy-specific shape
  needsEnrichment?: boolean;
}

@Injectable()
export class PostGenerationAgent implements OnModuleInit {
  private readonly logger = new Logger(PostGenerationAgent.name);
  private cwd!: string;

  constructor(
    private readonly config: ConfigService,
    private readonly structured: StructuredLoggerService,
  ) {}

  onModuleInit() {
    // apps/automation — .claude/ lives here
    this.cwd = join(__dirname, '..', '..', '..');
  }

  async generate(input: GenerateInput): Promise<string | 'SKIP_POST' | null> {
    const mainAgent = input.mode === 'news' ? 'main-news-agent' : 'main-simple-agent';
    const prompt    = this.buildPrompt(mainAgent, input);

    const start = Date.now();
    let finalText: string | null = null;

    try {
      for await (const msg of query({
        prompt,
        options: {
          cwd:               this.cwd,
          settingSources:    ['project'],
          allowedTools:      ['Task'],
          permissionMode:    'bypassPermissions',
          maxTurns:          12,
        },
      })) {
        if (msg.type === 'result' && msg.subtype === 'success') {
          finalText = msg.result?.trim() ?? null;
        }
      }
    } catch (err: any) {
      this.logger.error(`Agent run failed: ${err.message}`);
      this.structured.aiResponse({
        agent: mainAgent, model: 'agent-sdk',
        output: null, durationMs: Date.now() - start, error: err.message,
      });
      return null;
    }

    this.structured.aiResponse({
      agent: mainAgent, model: 'agent-sdk',
      output: finalText, durationMs: Date.now() - start,
    });

    if (!finalText) return null;
    if (finalText === 'SKIP_POST') return 'SKIP_POST';
    return finalText;
  }

  private buildPrompt(mainAgent: string, input: GenerateInput): string {
    return [
      `Route to: ${mainAgent}`,
      `Channel skill: ${input.channelSkill}`,
      input.needsEnrichment ? 'needsEnrichment: true' : 'needsEnrichment: false',
      '',
      'Raw data (JSON):',
      '```json',
      JSON.stringify(input.rawData, null, 2),
      '```',
    ].join('\n');
  }
}
```

### `AiModule` changes
- Register `PostGenerationAgent` as provider + export.
- Keep existing `ClaudeAgent`, `OpenAiAgent`, `GrokAgent`, `PerplexityAgent` available for anything
  not migrated (review, summarizer, non-AI paths).
- `SummarizerService` and `FormatterService` become **legacy** — marked `@deprecated`, not used by
  migrated strategies. Can be deleted once all in-scope strategies flip.

### Strategy call-site changes

Each migrated strategy replaces its `this.summarizer...` + `this.formatter...` + `this.reviewer...`
chain with a single `PostGenerationAgent.generate(...)` call.

Example for `ai0-news.strategy.ts` (replaces current `processItem` internals):

```ts
const result = await this.postAgent.generate({
  mode:            'news',
  channelSkill:    'channel-ai0-news',
  needsEnrichment: !item.content || item.content.length < 800,
  rawData: {
    title:   item.title,
    content: item.content,
    source:  item.source,
    tags:    item.tags,
  },
});

if (result === 'SKIP_POST' || !result) {
  await this.dedup.markPosted(item.source, item.title, channelId);
  return;
}

const text = this.buildMessage(result, item);
// ...existing publish flow unchanged
```

Same pattern for `ua-news`, `on-this-day` (`mode: 'news'`), and for `movies`, `space`, `recipes`,
`daily-photo`, `birthday-story`, `game-channel`, `assets` (`mode: 'simple'`,
`needsEnrichment: false`).

## Infrastructure

### Dependencies
Add to `apps/automation/package.json`:
```
"@anthropic-ai/claude-agent-sdk": "^latest"
```

`@anthropic-ai/sdk` stays (other services still use it). `claude` CLI is bundled with the agent-sdk
package — no separate install.

### Env vars
Already have `ANTHROPIC_API_KEY`. Claude Agent SDK uses the same key. No new env.

Optional:
- `POST_AGENT_MAX_TURNS` (default 12) — safety limit on subagent back-and-forth per run.

### Docker
The `claude` binary needs to run inside the container. Agent SDK ships it via npm — no apt install.
Confirm the runtime stage has Node ≥ 20 (already true).

No change to Dockerfile expected; validated during implementation.

### File layout added
```
apps/automation/
├── .claude/
│   ├── agents/
│   │   ├── main-news-agent.md
│   │   ├── main-simple-agent.md
│   │   ├── info-preparator.md
│   │   ├── post-writer.md
│   │   └── grammar-reviewer.md
│   └── skills/
│       ├── human-voice/SKILL.md
│       ├── anti-slop/SKILL.md
│       ├── grammar-ua/SKILL.md
│       ├── channel-ai0-news/SKILL.md
│       ├── channel-ua-news/SKILL.md
│       ├── channel-gaming/SKILL.md
│       ├── channel-movies/SKILL.md
│       ├── channel-space/SKILL.md
│       ├── channel-recipes/SKILL.md
│       ├── channel-daily-photo/SKILL.md
│       ├── channel-birthday-story/SKILL.md
│       └── channel-on-this-day/SKILL.md
├── src/
│   └── common/
│       └── ai/
│           ├── post-generation.agent.ts   [NEW]
│           ├── agents/                    [unchanged]
│           ├── skills/                    [DELETED after migration]
│           ├── formatter.service.ts       [deprecated, keep for non-migrated]
│           ├── summarizer.service.ts      [deprecated, keep for non-migrated]
│           └── ai.module.ts               [+ PostGenerationAgent]
```

### Dockerfile
Copy `.claude/` into the runtime image:
```dockerfile
COPY apps/automation/.claude ./apps/automation/.claude
```

## Error handling

- Agent run timeout / crash → `PostGenerationAgent.generate` returns `null`; strategy logs error and
  leaves dedup untouched (item retried next cron).
- Agent returns `SKIP_POST` → strategy marks item as posted in dedup to avoid re-processing, no
  Telegram publish.
- Subagent fails mid-run → main agent's final message will say so; we treat as `null` and skip.
- Token budget: `maxTurns: 12` caps runaway loops.

## Verification

1. `cd apps/automation && npx tsc -p tsconfig.json --noEmit` — no errors.
2. `.claude/agents/*.md` and `.claude/skills/*/SKILL.md` present in build output (copied via
   Dockerfile).
3. Local: trigger ai0-news once via `/run ai0-news` → structured log shows
   `{ agent: 'main-news-agent', model: 'agent-sdk', output: '...', durationMs: N }`.
4. Output text in Telegram matches Ukrainian style (sanity-check one post manually).
5. `needsEnrichment: true` path with short content → structured log shows info-preparator was
   invoked (visible in agent-sdk message stream if we log subagent dispatches).
6. `SKIP_POST` path: feed a paywall-stub URL, expect dedup marked + no publish.
7. Same flow for `ua-news`, then each simple-mode strategy incrementally.
8. `published_posts` table continues to get one row per successful publish — no regression.

## Out of scope (follow-up)

- Migrating DB-only strategies (quotes, facts, pdr-quiz, motivation-biography, ai0-prompts).
- Deleting `FormatterService` / `SummarizerService` — do after all in-scope strategies are verified
  on new pipeline.
- Deleting `ReviewAgent` — subsumed by grammar-reviewer subagent for all in-scope strategies. Can
  be removed in the cleanup PR together with `FormatterService` / `SummarizerService`.
- Multilingual support — current design is Ukrainian-only, matches current scope.
