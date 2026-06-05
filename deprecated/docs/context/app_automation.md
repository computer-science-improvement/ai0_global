---
name: app_automation
description: apps/automation — NestJS content automation service, strategies, AI skills, publishing
type: project
---

# Automation App (`apps/automation/`)

**Role**: Long-running NestJS service that fetches content, generates AI posts, and publishes to Telegram.

## Entry Points

- `src/main.ts` — bootstrap, port from `PORT` env (default 3000)
- `src/app.module.ts` — all module registrations
- `config/channels.json` — bot tokens (by env var name), channel IDs, strategy bindings with cron schedules

## Execution Pipeline (ContentStrategyRunner)

```
1. FETCH      strategy.fetch()        → raw content item
2. DEDUP      DedupService            → skip if already posted to channel
3. GENERATE   strategy.generate()     → AI-generated post text
4. REVIEW     ReviewAgent             → quality check (skills-based)
5. DOWNLOAD   ImageResolverService    → fetch image buffer
6. PUBLISH    TelegramPublisher       → send to Telegram (photo+caption)
7. MARK       DedupService.mark()     → record in posted_news table
```

Return `SKIP_POST` to mark as seen without publishing.

## Content Strategies (10 total) — `src/strategies/`

| Strategy | Type key | Data source | Channel |
|----------|----------|-------------|---------|
| ai0-news | ai0-news | RSS + scraper | AI news |
| recipes | recipes | MealDB API + DB | Recipes |
| daily-photo | daily-photo | NASA APOD API | Astronomy photos |
| on-this-day | on-this-day | `on_this_day` DB table | Historical events |
| quotes | quotes | `quotes` DB table | Quotes |
| movies | movies | TMDB API | Movies |
| space-news | space-news | Space news API | Space news |
| game-channel | game-channel | Epic/Steam/multiple | Gaming |
| ai0-prompts | ai0-prompts | PromptHero scraper | AI prompts |
| ua-news | ua-news | Configurable RSS | UA tech news |

## AI Agents — `src/common/ai/agents/`

- `claude.agent.ts` — **default**, model: `claude-haiku-4-5-20251001`
- `openai.agent.ts` — OpenAI Chat API
- `perplexity.agent.ts` — Perplexity
- `grok.agent.ts` — Grok/xAI
- `review.agent.ts` — post quality review

## Skills — `src/common/ai/skills/`

System prompt injections that shape AI tone and output:

| File | Purpose |
|------|---------|
| human-voice.skill.ts | Write like a human, no corporate language |
| anti-slop.skill.ts | Banned AI phrases and clichés |
| recipes-channel.skill.ts | Ukrainian food channel rules |
| daily-photo-channel.skill.ts | Astronomical photo descriptions |
| movies-channel.skill.ts | Movie recommendation format |
| space-channel.skill.ts | Space science accuracy |
| gaming-channel.skill.ts | Gaming deals and news |
| ai0-news-channel.skill.ts | AI/tech news tone |
| ua-news-channel.skill.ts | Ukrainian news sourcing |
| on-this-day-channel.skill.ts | Historical event storytelling |
| review.skill.ts | Quality review criteria |
| skip-signal.skill.ts | When to skip a post |

## Prompts — `src/common/ai/prompts/`

Each strategy has `*.prompts.ts` defining system prompt + user message builder.
Composed of base prompt + relevant skills.

**Example** (`recipes.prompts.ts`):
```
system: role + HUMAN_VOICE + ANTI_SLOP + RECIPES_CHANNEL skills
user: title, category, area, ingredients, instructions
output: JSON {description, ingredients_list}
```

## Publishers — `src/publishers/`

- `telegram.publisher.ts` — primary. Sends photo+caption. If caption > 1024 chars: photo + separate text message.
- `instagram.publisher.ts`, `threads.publisher.ts`, `facebook.publisher.ts` — Meta APIs

## Key Support Services

- `dedup.service.ts` — `posted_news` table (source_url + channel_id)
- `ai-logger.service.ts` — logs to `ai_logs`
- `bot-logger.service.ts` — logs to `bot_logs`
- `content-cleaner.service.ts` — HTML sanitizer
- `image-resolver.service.ts` — downloads images by URL

## Scheduler

`scheduler.service.ts` reads channels.json strategies, creates CronJobs.
Each strategy has a `schedule` cron expression (e.g. `*/5 * * * *`).

## channels.json Structure

```json
{
  "bots": { "bot_id": { "platform": "telegram", "tokenEnv": "ENV_VAR_NAME" } },
  "channels": { "@channel": { "platform": "telegram", "chatId": "@channel", "botId": "bot_id" } },
  "strategies": [
    { "id": "recipes:dev", "type": "recipes", "channelId": "@recipes_dev", "schedule": "*/5 * * * *" }
  ]
}
```
