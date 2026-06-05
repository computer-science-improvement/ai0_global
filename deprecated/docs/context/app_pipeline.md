---
name: app_pipeline
description: apps/pipeline — offline data scraping/parsing/loading into PostgreSQL, scripts and datasets
type: project
---

# Pipeline App (`apps/pipeline/`)

**Role**: Offline data processing. Scrapes external sources, parses to JSON, loads into PostgreSQL.
**Language**: Node.js ESM (`.js`) for main scripts, TypeScript (`.ts` via `npx tsx`) for scraping scripts.

## npm Scripts

```bash
pnpm run parse              # All parsers → data/raw or data/normalized
pnpm run load:all           # All loaders → PostgreSQL
pnpm run load:recipes       # normalized/recipes/recipes.json → recipes
pnpm run load:daytoday      # normalized/daytoday/*.json → multiple tables
pnpm run load:prompts       # normalized/prompts/*.json → prompts
pnpm run load               # raw/assets/*.json → assets
pnpm run init-db            # Create tables (idempotent)
pnpm run init-db:reset      # Drop + recreate
pnpm run db:seed            # init-db + load:all
pnpm run db:reset           # init-db:reset + load:all
pnpm run sync               # parse + load:all
```

Env: `node --env-file=../../.env` — reads root `.env`
Env: `LOAD_LIMIT=N` — load only first N rows (testing)

## Directory Structure

```
apps/pipeline/
├── src/
│   ├── parsers/          External source parsers → lifecycle JSON in data/
│   │   ├── academy.openai.js
│   │   ├── academy.openai.resources.js
│   │   ├── mcpservers.js
│   │   ├── prompts-md.js
│   │   └── samorozvytok-motivatory.js
│   ├── run-parsers.js    Auto-runs parser files in src/parsers/
│   ├── loaders/          JSON → PostgreSQL
│   │   ├── assets.js      data/raw/assets/*.json → assets
│   │   ├── prompts.js     data/normalized/prompts/*.json → prompts
│   │   ├── recipes.js     data/normalized/recipes/recipes.json → recipes
│   │   ├── daytoday.js    data/normalized/daytoday/*.json → on_this_day/articles/jokes/quotes/name_days/birthdays
│   │   ├── facts.js       data/normalized/faktypro/articles.json → facts
│   │   ├── pdr.js         data/normalized/pdr/tickets.json → pdr_questions
│   │   ├── tg-posts.js    data/publish-ready/tg/*.json → tg_posts
│   │   └── _template.js
│   ├── tg/               AI adaptation scripts for Telegram
│   ├── lib/
│   │   ├── db.js          pg pool
│   │   ├── loader.js      upsert helper: loadRows(table, rows, opts)
│   │   ├── scrape.js      cheerio helpers
│   │   ├── fetch.js       axios with retry
│   │   ├── text.js        cleanTitleOrDescription(), slugify()
│   │   └── json.js        lifecycle path/write helpers
│   └── init-db.js         Schema initialization
├── additional-data/
│   ├── scripts/           Specialized scraping scripts (run with npx tsx)
│   │   ├── scrape-daytoday.ts       daytoday.ua events → JSON
│   │   ├── scrape-daytoday-articles.ts
│   │   ├── scrape-foodcourt.ts
│   │   ├── scrape-faktypro.ts
│   │   ├── pdr-login.ts
│   │   └── scrape-pdr-tickets.ts
└── data/
    ├── raw/              scraper/parser raw outputs
    ├── normalized/       canonical datasets used by loaders/adapters
    ├── generated/        intermediate generated artifacts
    └── publish-ready/    final publish-ready assets (for tg loaders)
```

## Data lifecycle conventions

- `raw` -> network/parser outputs that may still contain source-specific structure
- `normalized` -> stable shape consumed by loaders and adapters
- `generated` -> optional generated intermediate files
- `publish-ready` -> final post payloads used by publish loaders

Reference mapping is tracked in `apps/pipeline/docs/data-lifecycle-migration-map.md`.

## FoodCourt Scraper (`scrape-foodcourt.ts`)

Uses WordPress REST API (`/wp-json/wp/v2/posts`).
Parses HTML content with cheerio:
- **Ingredients**: from `.wp-block-media-text__content` children before `<hr>` — handles both `<p>` and `<ul><li>` formats
- **Instructions**: numbered `<p>` tags after "Приготування" heading — regex `/^\d+\S/`, normalises Unicode dot leaders
- **Image**: largest URL from `srcset` in `.wp-block-media-text__media img`
- **Category**: priority-based from WP category IDs
- **Tags**: WP tag names → lowercase with underscores

Run: `npx tsx apps/pipeline/additional-data/scripts/scrape-foodcourt.ts`

## Root Scripts (scripts/)

| File | Purpose |
|------|---------|
| scrape-recipes.sh | Shell wrapper for recipe scraping |
| format-posts.sh | ★ Launches `claude -p` agent to format all scraped recipes as Telegram posts |

### format-posts.sh
- Reads skills from `apps/automation/src/common/ai/skills/` (anti-slop, human-voice, recipes-channel)
- Runs `claude -p` with `--allowedTools Read,Write --model sonnet --max-turns 120`
