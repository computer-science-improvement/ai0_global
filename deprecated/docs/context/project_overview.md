---
name: project_overview
description: ai0_global monorepo — purpose, structure, data flow, tech stack
type: project
---

# AI0 Global — Project Overview

**Purpose**: Monorepo for automated content generation and publishing to Telegram (+ Instagram/Threads/Facebook). Combines offline data pipeline with a live NestJS automation service.

## Monorepo Layout

```
ai0_global/
├── apps/
│   ├── automation/     NestJS 24/7 service — AI generation + publishing
│   └── pipeline/       Node.js offline data processing — scrape, parse, load
├── database/
│   └── init.sql        PostgreSQL schema (idempotent, run once)
├── docs/               Project docs
├── scripts/            Root shell scripts (scrape-recipes.sh, format-posts.sh)
├── docker-compose.yml  DB + automation + pipeline profiles
├── package.json        Root pnpm workspace scripts
└── pnpm-workspace.yaml apps/*
```

**Package manager**: pnpm. Both apps have independent deps.

## Core Data Flow

```
External Source
     ↓
Pipeline (parse/scrape → lifecycle data/ -> PostgreSQL tables)
     ↓
Database (assets, recipes, on_this_day, quotes, prompts, articles, jokes)
     ↓
Automation (fetch from DB/API → AI generate → review → publish → mark dedup)
     ↓
Telegram channel (+ Instagram/Threads/Facebook)
```

## Tech Stack

| App | Runtime | Framework | AI | DB |
|-----|---------|-----------|----|----|
| automation | Node 20 / TS | NestJS 10 | Claude (default), OpenAI, Perplexity, Grok | pg (raw) |
| pipeline | Node 20 / JS+TS | ESM scripts | — | pg (raw) |

Both apps share same PostgreSQL 16 instance (Docker, port 5433 on host).

## Environment Variables (from .env)

```
POSTGRES_HOST / PORT / DB / USER / PASSWORD
TELEGRAM_AI0_BOT_TOKEN
ANTHROPIC_API_KEY
OPENAI_API_KEY / PERPLEXITY_API_KEY / GROK_API_KEY
INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_ACCOUNT_ID
THREADS_ACCESS_TOKEN / THREADS_USER_ID
FACEBOOK_ACCESS_TOKEN / FACEBOOK_PAGE_ID
FETCH_TIMEOUT=15000
```

## Docker Profiles

```bash
docker compose up -d postgres                      # DB only (dev)
docker compose --profile prod up -d               # DB + automation
docker compose --profile pipeline run --rm pipeline pnpm run sync  # data refresh
```

## Root npm Scripts

```bash
pnpm db:up / db:down             # Start/stop postgres
pnpm dev:automation              # NestJS watch mode
pnpm prod:up / prod:down         # Production docker
pnpm pipeline:sync               # parse + load:all in docker
pnpm migrate                     # init-db in pipeline
```

## Pipeline Data Lifecycle

`apps/pipeline/data` is organized by lifecycle stages:

- `raw/` — raw parser outputs
- `normalized/` — normalized datasets for loaders/adapters
- `generated/` — intermediate generated artifacts
- `publish-ready/` — final posting payloads (for `tg_posts` loader)
