---
name: database_schema
description: PostgreSQL schema — tables, purposes, dedup keys, how loaded/used
type: project
---

# Database Schema

**File**: `database/init.sql` (idempotent — all `CREATE IF NOT EXISTS`)
**Connection**: PostgreSQL 16, Docker port 5433 (host) → 5432 (container)

## Content Tables

| Table | Dedup Key | Loaded by | Used by |
|-------|-----------|-----------|---------|
| `assets` | `(data_source, title)` | pipeline/loaders/assets.js | — |
| `prompts` | `(id)` | pipeline/loaders/prompts.js | ai0-prompts strategy |
| `recipes` | `(slug)` | pipeline/loaders/recipes.js | recipes strategy |
| `on_this_day` | `(month, day, slug)` | pipeline/loaders/daytoday.js | on-this-day strategy |
| `articles` | `(slug)` | pipeline/loaders/daytoday.js | — |
| `quotes` | `(text_hash)` | manual seed | quotes strategy |
| `jokes` | `(content_hash)` | — (unused currently) | — |

All content tables have a `posted` JSONB column tracking which channels have published each item.

## Infrastructure Tables

| Table | Purpose |
|-------|---------|
| `posted_news` | Dedup: `(source_url, channel_id)` — prevents reposting |
| `ai_logs` | AI request audit: input, output, model, duration, strategy |
| `bot_logs` | Publish audit: success/error per channel per post |

## recipes table fields

`id, slug, title, url, description, ingredients, instructions, image_url, category, tags (text[]), post_text, posted (jsonb), created_at`

## on_this_day table fields

`id, month, day, slug, title, description, source_url, posted (jsonb), created_at`

## posted_news table

`id, source_url, channel_id, strategy_type, posted_at`
Used by `DedupService` in automation to prevent duplicate posts.

## GIN Indexes

JSONB columns (`posted` in content tables) have GIN indexes for efficient channel-based dedup queries.
