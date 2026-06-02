# Curated Prompts Import (nanobanana + seedance) — Design

**Date:** 2026-05-26
**Status:** Approved (brainstorming)
**Scope:** Import AI prompts from two GitHub repos into the existing `prompts` table and add one new posting strategy. Recipes were a separate, completed spec.

## Goal

Import image prompts from `github.com/ZeroLu/awesome-nanobanana-pro` and video prompts from `github.com/ZeroLu/awesome-seedance` into the `prompts` table (extended to store the prompt text + media inline), and add a single `curated-prompts` strategy that posts them — deterministically, no Claude (prompts are posted verbatim, mirroring the existing `ai0-prompts` message format). Image → `sendPhoto`, video → `sendVideo`.

## Context (current state)

- **`prompts` table** (`database/init.sql`): `id TEXT PRIMARY KEY` (an image URL), `prompt_source`, `category`, `posted JSONB`, `scraped_at`, `page_url`, `status`, `created_at`. Indexes on category / posted (GIN) / status.
- **`ai0-prompts` strategy** scrapes prompthero pages at post time — it does NOT store prompt text. Its `PromptsRepository.getNext(category)` selects `WHERE category=$1 AND status IS NULL AND NOT (posted ? 'TELEGRAM')`. Incompatible with inline-text GitHub prompts, so the new rows need a discriminator and that query needs a filter.
- **`PromptHeroScraperService.buildMessage`** is the post-format reference: `💬 Prompt:` + `<code>{prompt}</code>` + model/param lines + `#category` hashtag; caption capped at 1024.
- **`TelegramPublisher.publishPrompt({ imageBuffer, caption, replyText? }, target)`** does photo+caption then optional reply. There is **no** video path yet.
- **Repo markdown structure (both):** `## N. Category` → `### N.M. Title` → italic one-line description → media → prompt in a ```` ``` ```` fenced block → `*Source: …*`.
  - nanobanana media: `<img width="400" alt="…" src="https://github.com/user-attachments/assets/<uuid>" />` (image). ~95 prompts across 10 categories.
  - seedance media: a bare line `https://github.com/user-attachments/assets/<uuid>` (an mp4 video). ~45 prompts across 7 categories.

## Decisions (locked during brainstorming)

1. **Extend the existing `prompts` table** (not a new table); add a `provider` discriminator + inline text/media columns.
2. **Video posted natively** via a new `sendVideo` path (image→sendPhoto, video→sendVideo).
3. **Import categories as-is** (strip the leading `"N. "`), stored in `category`.
4. **One strategy** `curated-prompts`, filtered by binding `params` (`provider` / `media_type`) — images→channel A, videos→channel B.
5. **Post format mirrors `ai0-prompts`** (prompt verbatim in `<code>`, category hashtag, source line). No translation, no Claude.
6. `id` (PK) for new rows = `media_url` (the unique GitHub asset URL).

## Architecture / data flow

```
README (raw .md) ── scrape:prompts-github ──▶ raw-data/raw-data/prompts-github/{nanobanana,seedance}.md
        │  parser: parsers/prompts-github.js  (markdown → normalized entries)
        ▼
data/normalized/prompts-github/prompts.json
        │  loader: loaders/prompts-github.js  (ON CONFLICT (id) DO NOTHING)
        ▼
Postgres: prompts table (extended: provider/title/prompt_text/source/media_url/media_type)
        │  curated-prompts strategy execute() (params: provider/media_type)
        │    getNext → build caption/reply (verbatim) → download/stream media
        │    → image: publishPrompt | video: publishVideo → markPosted
        ▼
Telegram (photo or video + caption; long prompt → reply)   |   posted = {TELEGRAM: ts}
```

## Components

### 1. Migration — `database/migrations/010_curated_prompts.sql` (NEW)

```sql
ALTER TABLE prompts
  ADD COLUMN IF NOT EXISTS provider    TEXT NOT NULL DEFAULT 'prompthero',
  ADD COLUMN IF NOT EXISTS title       TEXT,
  ADD COLUMN IF NOT EXISTS prompt_text TEXT,
  ADD COLUMN IF NOT EXISTS source      TEXT,
  ADD COLUMN IF NOT EXISTS media_url   TEXT,
  ADD COLUMN IF NOT EXISTS media_type  TEXT;   -- 'image' | 'video'

-- Existing rows are prompthero (the DEFAULT already covers new inserts;
-- this is explicit for any pre-existing NULLs from older schemas).
UPDATE prompts SET provider = 'prompthero' WHERE provider IS NULL;

CREATE INDEX IF NOT EXISTS idx_prompts_provider ON prompts (provider);

INSERT INTO schema_migrations (version) VALUES ('010_curated_prompts')
  ON CONFLICT (version) DO NOTHING;
```

Mirror the six columns + index into `database/init.sql`'s `prompts` table for fresh installs.

### 2. Fetch step — `apps/pipeline/src/tools/scrape-prompts-github.js` (NEW)

- Fetches the two raw READMEs and writes them to `raw-data/raw-data/prompts-github/nanobanana.md` and `seedance.md`.
- URLs: `https://raw.githubusercontent.com/ZeroLu/awesome-nanobanana-pro/main/README.md` and `…/awesome-seedance/main/README.md`.
- npm script `scrape:prompts-github`. Network only here; keeps the parser deterministic/offline.

### 3. Parser — `apps/pipeline/src/parsers/prompts-github.js` (NEW)

- Reads the two saved `.md` files. For each, walks the markdown:
  - Track current category from `## ` headings; strip a leading `"N. "` → clean `category`.
  - Each `### ` heading starts a prompt entry: `title` = heading text (strip `"N.M. "`).
  - `description` = the italic line under the title (optional).
  - `prompt_text` = the contents of the first fenced ```` ``` ```` block in the entry.
  - `media_url` + `media_type`:
    - `<img ... src="URL">` → `image`.
    - a bare `https://github.com/user-attachments/assets/...` line → `video`.
  - `source` = the `*Source: …*` line (kept as plain text, links stripped to `@handle`/name).
  - `provider` = `nanobanana` (from the nanobanana file) or `seedance` (from the seedance file).
- Skip entries missing `prompt_text` or `media_url`; count skipped.
- Dedup within the dataset by `media_url`.
- Normalized record shape:
  ```json
  { "id": "<media_url>", "provider": "nanobanana", "category": "Photorealism & Aesthetics",
    "title": "Hyper-Realistic Crowd Composition", "prompt_text": "Create a hyper-realistic…",
    "source": "@SebJefferies", "media_url": "https://…", "media_type": "image",
    "prompt_source": "https://github.com/ZeroLu/awesome-nanobanana-pro", "page_url": "https://…" }
  ```
  (`prompt_source`/`page_url` reuse existing NOT-NULL-friendly columns: `prompt_source` = repo URL.)
- Write `data/normalized/prompts-github/prompts.json` (`{ prompts: [...] }`).
- Pure exported fns for tests: `parseReadme(md, provider)`, `cleanCategory(s)`, `cleanTitle(s)`, `extractMedia(block)`.
- npm script `parse:prompts-github`.

### 4. Loader — `apps/pipeline/src/loaders/prompts-github.js` (NEW)

- Reads the normalized JSON, maps to columns `['id','provider','category','title','prompt_text','source','media_url','media_type','prompt_source','page_url','posted']` (`posted='{}'`), inserts via the shared `loadRows('prompts', rows, { columns, conflictTarget: '(id)' })`.
- npm scripts `load:prompts-github` and `load:prompts-github:test` (`LOAD_LIMIT`).
- Idempotent (ON CONFLICT (id) DO NOTHING). No TRUNCATE (the table also holds prompthero rows).

### 5. Repository — `apps/automation/src/strategies/curated-prompts/curated-prompts.repository.ts` (NEW)

Inject `DB_POOL`.
- `getNext(filter: { provider?: string; mediaType?: string }): Promise<CuratedPromptRow | null>`
  ```sql
  SELECT id, category, title, prompt_text, source, media_url, media_type
  FROM prompts
  WHERE provider <> 'prompthero'
    AND prompt_text IS NOT NULL
    AND NOT (posted ? 'TELEGRAM')
    AND status IS DISTINCT FROM 'ERROR'
    AND ($1::text IS NULL OR provider   = $1)
    AND ($2::text IS NULL OR media_type = $2)
  ORDER BY created_at
  LIMIT 1
  ```
- `markPosted(id)` — `posted = posted || jsonb_build_object('TELEGRAM', NOW())`.
- `markError(id)` — `status = 'ERROR'` (skip permanently, e.g. media gone).

### 6. Strategy — `apps/automation/src/strategies/curated-prompts/curated-prompts.strategy.ts` (NEW)

- `type = 'curated-prompts'`; registers in `onModuleInit`.
- `execute(channelId, params)`:
  1. `row = repo.getNext({ provider: params.provider, mediaType: params.mediaType })`. Null → log + return.
  2. Build the message (mirroring `buildMessage`), HTML-escaping the prompt:
     - `caption` candidate = `<b>{title}</b>` + `💬 Prompt:` + `<code>{prompt_text}</code>` + `#{category_hashtag}` + (source line).
     - If visible length ≤ 1024 → caption holds everything, no reply.
     - Else → short caption (`<b>{title}</b>` + `#{hashtag}`), and `replyText` carries `💬 Prompt:\n<code>{prompt_text}</code>\n\n{source}` (Telegram message limit 4096; truncate on boundary + `…` if longer).
  3. Publish by media type:
     - `image` → download `media_url` → Buffer → `publisher.publishPrompt({ imageBuffer, caption, replyText }, { id: channelId })`.
     - `video` → `publisher.publishVideo({ videoUrl: media_url, caption, replyText }, { id: channelId })` (URL streamed by Telegram — no large buffer).
  4. On media/publish failure → log; do NOT mark posted (retry). On a 404/permanently-gone media → `markError`.
  5. `repo.markPosted(row.id)` on success.
- No Claude, no validator needed (verbatim). `getSkills()` returns `[]`.

### 7. Publisher — add `publishVideo` to `TelegramPublisher`

```ts
async publishVideo(payload: { videoUrl: string; caption: string; replyText?: string }, target: PublishTarget): Promise<string>
```
- Honors `isPublishPausedFor` (throws `ChannelPausedError`) — same guard as `publishPrompt`.
- `sendVideo` with `video=<url>`, `caption`, `parse_mode=HTML` (caption ≤ 1024). If `replyText`, follow with `sendReply`.
- Records throttle + structured publication like `publishPrompt`.

### 8. Existing `ai0-prompts` — one-line filter

`PromptsRepository.getNext` gains `AND provider = 'prompthero'` so the prompthero strategy never picks up GitHub rows. No other change.

## Error handling

- Fetch step: fail loudly if a README can't be downloaded (manual, run rarely).
- Parser: skip+count malformed entries; never throw on one bad entry.
- Loader: `ON CONFLICT (id) DO NOTHING`; idempotent.
- Strategy: media download/stream/publish failure → no `markPosted` (retry next run); confirmed-gone media → `markError`. `ChannelPausedError` handled by scheduler as `skipped`.

## Testing (cost-safe — no Claude, no Telegram, no network in tests)

- **Parser unit tests** (`node --test`): category/title cleaning, image vs video media extraction, fenced-block prompt capture, source parsing, skip malformed, dedup by media_url, provider tagging. Markdown fixtures.
- **Loader test:** local Postgres + small fixture + `LOAD_LIMIT`; row count, idempotent re-run, columns populated.
- **Migration test:** apply 010; assert the six columns + provider index exist; existing rows are `provider='prompthero'`.
- **Repository test (or psql dry-run):** `getNext` respects provider/media_type filters and excludes prompthero + posted + ERROR rows.
- **Strategy unit tests (mocked publisher + repo, no network):** image row → `publishPrompt` called; video row → `publishVideo` called; long prompt → caption short + reply carries prompt; media download failure → no `markPosted`; caption HTML-escaped.
- **Publisher:** `publishVideo` builds the right `sendVideo` form and honors `publish_paused` (unit test with axios mocked, or covered via the strategy test with a fake publisher).
- **Standing cost rule:** strategy stays **unbound / automation not running** during development; the existing `ai0-prompts` flow is unaffected except the provider filter.

## Out of scope

- Translating prompts (verbatim by decision 5).
- Dashboard UI for browsing curated prompts.
- Auto-refresh of the repos on a schedule (manual `scrape` + `load` for now).
- De-duplicating GitHub prompts against existing prompthero rows (different providers, different media URLs).
