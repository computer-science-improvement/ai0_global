# Curated Prompts Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import image prompts (nanobanana) and video prompts (seedance) from two GitHub READMEs into the extended `prompts` table, and add one `curated-prompts` strategy that posts them verbatim (no Claude) — image via `sendPhoto`, video via a new `sendVideo` path.

**Architecture:** Pipeline side — a fetch step saves the two READMEs, a parser turns markdown into normalized prompt records, a loader inserts them into `prompts` (ON CONFLICT id). Automation side — migration 010 extends `prompts` with `provider/title/prompt_text/source/media_url/media_type`; a `CuratedPromptsRepository` selects the next unposted GitHub prompt filtered by binding `params`; the `curated-prompts` strategy renders a verbatim caption/reply (mirroring `ai0-prompts`) and publishes by media type; the existing `ai0-prompts` repo query gains a `provider='prompthero'` filter so it ignores the new rows.

**Tech Stack:** Node ESM (pipeline, `pg`, `loadRows`), NestJS + TypeScript (automation), axios, Postgres. Tests: `node --test` (pipeline JS) and `node --import tsx --test` (automation TS), both `node:test`.

**Spec:** `docs/superpowers/specs/2026-05-26-curated-prompts-import-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `database/migrations/010_curated_prompts.sql` | **create** | Extend `prompts` with provider/title/prompt_text/source/media_url/media_type + index. |
| `database/init.sql` | **modify** | Mirror the six columns + provider index into the baseline `prompts` table. |
| `apps/pipeline/src/tools/scrape-prompts-github.js` | **create** | Fetch the two raw READMEs → `raw-data/raw-data/prompts-github/*.md`. |
| `apps/pipeline/src/parsers/prompts-github.js` | **create** | Markdown → normalized prompt records (pure fns + `main`). |
| `apps/pipeline/src/parsers/prompts-github.test.js` | **create** | `node:test` for the parser. |
| `apps/pipeline/src/loaders/prompts-github.js` | **create** | Normalized JSON → `prompts` (ON CONFLICT id). |
| `apps/pipeline/package.json` | **modify** | Add `scrape:prompts-github`, `parse:prompts-github`, `load:prompts-github(:test)`. |
| `apps/automation/src/strategies/ai0-prompts/prompts.repository.ts` | **modify** | Add `AND provider = 'prompthero'` to `getNext`. |
| `apps/automation/src/publishers/telegram.publisher.ts` | **modify** | Add `publishVideo`. |
| `apps/automation/src/strategies/curated-prompts/curated-prompts.repository.ts` | **create** | `getNext(filter)` / `markPosted` / `markError`. |
| `apps/automation/src/strategies/curated-prompts/curated-prompts.strategy.ts` | **create** | DB-backed `execute()` (image→publishPrompt, video→publishVideo). |
| `apps/automation/src/strategies/curated-prompts/curated-prompts.strategy.test.ts` | **create** | `node:test` with fakes. |
| `apps/automation/src/strategies/curated-prompts/curated-prompts-strategy.module.ts` | **create** | Provides strategy + repository. |
| `apps/automation/src/app.module.ts` | **modify** | Register `CuratedPromptsStrategyModule`. |

DB-bound units (migration, loader, repository) are verified against local Postgres in Task 10, matching repo conventions (no DB-bound unit tests exist).

---

## Task 1: Migration 010 + init.sql

**Files:**
- Create: `database/migrations/010_curated_prompts.sql`
- Modify: `database/init.sql`

- [ ] **Step 1: Write the migration**

Create `database/migrations/010_curated_prompts.sql`:

```sql
-- 010_curated_prompts.sql
-- Extend prompts to store curated GitHub-sourced prompts (nanobanana images,
-- seedance videos) inline. `provider` discriminates these from the existing
-- prompthero rows (which store no text and are scraped at post time).

ALTER TABLE prompts
  ADD COLUMN IF NOT EXISTS provider    TEXT NOT NULL DEFAULT 'prompthero',
  ADD COLUMN IF NOT EXISTS title       TEXT,
  ADD COLUMN IF NOT EXISTS prompt_text TEXT,
  ADD COLUMN IF NOT EXISTS source      TEXT,
  ADD COLUMN IF NOT EXISTS media_url   TEXT,
  ADD COLUMN IF NOT EXISTS media_type  TEXT;

UPDATE prompts SET provider = 'prompthero' WHERE provider IS NULL;

CREATE INDEX IF NOT EXISTS idx_prompts_provider ON prompts (provider);

INSERT INTO schema_migrations (version) VALUES ('010_curated_prompts')
  ON CONFLICT (version) DO NOTHING;
```

- [ ] **Step 2: Mirror into init.sql**

In `database/init.sql`, find `create table if not exists prompts (...)`. Add the six columns just before `created_at`:

```sql
  status        text,
  provider      text not null default 'prompthero',
  title         text,
  prompt_text   text,
  source        text,
  media_url     text,
  media_type    text,
  created_at    timestamptz not null default now()
```

And add alongside the other prompts indexes:

```sql
create index if not exists idx_prompts_provider on prompts (provider);
```

- [ ] **Step 3: Apply + verify**

```bash
docker exec -i ai0_global-postgres-1 psql -U ai0 -d ai0global < database/migrations/010_curated_prompts.sql
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c "\d prompts" | grep -E "provider|prompt_text|media_url|media_type|title|source"
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c "SELECT provider, count(*) FROM prompts GROUP BY provider;"
```

Expected: six columns present; all existing rows show `provider = prompthero`.

- [ ] **Step 4: Commit**

```bash
git add database/migrations/010_curated_prompts.sql database/init.sql
git commit -m "$(cat <<'EOF'
feat(db): migration 010 — extend prompts for curated GitHub prompts

Adds provider/title/prompt_text/source/media_url/media_type to prompts so
nanobanana (image) and seedance (video) prompts live inline alongside the
existing prompthero rows. Existing rows default to provider='prompthero'.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Fetch step (save the two READMEs)

**Files:**
- Create: `apps/pipeline/src/tools/scrape-prompts-github.js`
- Modify: `apps/pipeline/package.json`

- [ ] **Step 1: Implement the fetch tool**

Create `apps/pipeline/src/tools/scrape-prompts-github.js`:

```js
/**
 * Save the two GitHub prompt-repo READMEs locally so the parser can run
 * deterministically/offline. Network lives here only.
 */
import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR   = join(__dirname, '..', 'raw-data', 'raw-data', 'prompts-github');

const SOURCES = [
  { name: 'nanobanana', url: 'https://raw.githubusercontent.com/ZeroLu/awesome-nanobanana-pro/main/README.md' },
  { name: 'seedance',   url: 'https://raw.githubusercontent.com/ZeroLu/awesome-seedance/main/README.md' },
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const s of SOURCES) {
    const res = await fetch(s.url);
    if (!res.ok) throw new Error(`Fetch ${s.name} failed: ${res.status} ${res.statusText}`);
    const md = await res.text();
    const out = join(OUT_DIR, `${s.name}.md`);
    await writeFile(out, md, 'utf-8');
    console.log(`Saved ${s.name}: ${md.length} bytes → ${out}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Add npm script**

In `apps/pipeline/package.json` `scripts`, add:

```json
    "scrape:prompts-github": "node src/tools/scrape-prompts-github.js",
```

- [ ] **Step 3: Run it (network) + verify the files exist**

```bash
cd apps/pipeline && pnpm run scrape:prompts-github
ls -la src/raw-data/raw-data/prompts-github/
head -30 src/raw-data/raw-data/prompts-github/nanobanana.md
```

Expected: two `.md` files saved; the head shows `## 1. …` / `### 1.1. …` structure.

- [ ] **Step 4: Commit**

```bash
git add apps/pipeline/src/tools/scrape-prompts-github.js apps/pipeline/package.json
git commit -m "$(cat <<'EOF'
feat(pipeline): fetch nanobanana + seedance READMEs

scrape:prompts-github saves both raw READMEs under raw-data/prompts-github
so the parser stays deterministic and offline. Network only here.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Parser (markdown → normalized records)

**Files:**
- Create: `apps/pipeline/src/parsers/prompts-github.js`
- Test: `apps/pipeline/src/parsers/prompts-github.test.js`
- Modify: `apps/pipeline/package.json`

- [ ] **Step 1: Write the failing test**

Create `apps/pipeline/src/parsers/prompts-github.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCategory, cleanTitle, parseReadme } from './prompts-github.js';

const NANO = `# Awesome NanoBanana

## 1. Photorealism & Aesthetics

### 1.1. Hyper-Realistic Crowd Composition
*Handling complex compositions.*
<img width="400" alt="Crowd" src="https://github.com/user-attachments/assets/img-uuid-1" />

**Prompt:**
\`\`\`text
Create a hyper-realistic editorial cover.
\`\`\`
*Source: [@SebJefferies](https://x.com/SebJefferies/status/1)*

## 11. Resources
Some links, no prompts here.
`;

const SEED = `# Awesome Seedance

## 1. Cinematic Film Styles

### 1.1. Racing Movie Style
*Le Mans cinematic.*

**Prompt:**
\`\`\`
Style: Hollywood Racing. Duration: 15s.
\`\`\`

https://github.com/user-attachments/assets/vid-uuid-1

*Source: John ([@johnAGI168](https://x.com/johnAGI168)) - [Post](https://x.com/johnAGI168/status/2)*
`;

test('cleanCategory strips the leading "N. "', () => {
  assert.equal(cleanCategory('1. Photorealism & Aesthetics'), 'Photorealism & Aesthetics');
});

test('cleanTitle strips the leading "N.M. "', () => {
  assert.equal(cleanTitle('1.1. Hyper-Realistic Crowd Composition'), 'Hyper-Realistic Crowd Composition');
});

test('parseReadme: nanobanana image entry', () => {
  const rows = parseReadme(NANO, 'nanobanana');
  assert.equal(rows.length, 1); // Resources section yields nothing
  const r = rows[0];
  assert.equal(r.provider, 'nanobanana');
  assert.equal(r.category, 'Photorealism & Aesthetics');
  assert.equal(r.title, 'Hyper-Realistic Crowd Composition');
  assert.equal(r.prompt_text, 'Create a hyper-realistic editorial cover.');
  assert.equal(r.media_type, 'image');
  assert.equal(r.media_url, 'https://github.com/user-attachments/assets/img-uuid-1');
  assert.equal(r.id, r.media_url);
  assert.match(r.source, /SebJefferies/);
});

test('parseReadme: seedance video entry', () => {
  const rows = parseReadme(SEED, 'seedance');
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.provider, 'seedance');
  assert.equal(r.category, 'Cinematic Film Styles');
  assert.equal(r.media_type, 'video');
  assert.equal(r.media_url, 'https://github.com/user-attachments/assets/vid-uuid-1');
  assert.match(r.prompt_text, /Hollywood Racing/);
});

test('parseReadme: dedup by media_url', () => {
  const rows = parseReadme(NANO + NANO, 'nanobanana');
  assert.equal(rows.length, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/pipeline && node --test src/parsers/prompts-github.test.js`
Expected: FAIL — cannot find module `./prompts-github.js`.

- [ ] **Step 3: Implement the parser**

Create `apps/pipeline/src/parsers/prompts-github.js`:

```js
/**
 * Parser: raw-data/prompts-github/{nanobanana,seedance}.md → normalized prompts.
 *
 * Markdown shape (both repos):
 *   ## N. Category
 *   ### N.M. Title
 *   *italic description*
 *   <img src="..."> (image)  OR  bare https://github.com/user-attachments/assets/... line (video)
 *   **Prompt:**
 *   ```[lang]
 *   <prompt text>
 *   ```
 *   *Source: ...*
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_DIR   = join(__dirname, '..', 'raw-data', 'raw-data', 'prompts-github');
const OUT_FILE  = join(__dirname, '..', 'data', 'normalized', 'prompts-github', 'prompts.json');

const REPO_URL = {
  nanobanana: 'https://github.com/ZeroLu/awesome-nanobanana-pro',
  seedance:   'https://github.com/ZeroLu/awesome-seedance',
};

export function cleanCategory(s) {
  return String(s).replace(/^\s*\d+(\.\d+)*\.?\s*/, '').trim();
}

export function cleanTitle(s) {
  return String(s).replace(/^\s*\d+(\.\d+)*\.?\s*/, '').trim();
}

function extractMedia(bodyLines) {
  for (const line of bodyLines) {
    const img = line.match(/<img[^>]*\ssrc=["']([^"']+)["']/i);
    if (img) return { media_url: img[1], media_type: 'image' };
  }
  for (const line of bodyLines) {
    const vid = line.trim().match(/^(https:\/\/github\.com\/user-attachments\/assets\/\S+)$/i);
    if (vid) return { media_url: vid[1], media_type: 'video' };
  }
  return null;
}

function extractPrompt(bodyLines) {
  let inBlock = false;
  const buf = [];
  for (const line of bodyLines) {
    if (!inBlock && /^```/.test(line.trim())) { inBlock = true; continue; }
    if (inBlock && /^```/.test(line.trim()))  { break; }
    if (inBlock) buf.push(line);
  }
  const text = buf.join('\n').trim();
  return text || null;
}

function extractSource(bodyLines) {
  const line = bodyLines.find((l) => /^\*?\s*Source:/i.test(l.trim()));
  if (!line) return null;
  const handle = line.match(/@[\w]+/);          // prefer an @handle
  if (handle) return handle[0];
  return line.replace(/^\*?\s*Source:\s*/i, '').replace(/[*]/g, '').trim() || null;
}

/** Parse one README's markdown into normalized prompt records. */
export function parseReadme(md, provider) {
  const lines = md.split('\n');
  let category = null;
  const entries = [];
  let cur = null;

  const flush = () => { if (cur) { entries.push(cur); cur = null; } };

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h2) { flush(); category = cleanCategory(h2[1]); continue; }
    if (h3) { flush(); cur = { title: cleanTitle(h3[1]), category, body: [] }; continue; }
    if (cur) cur.body.push(line);
  }
  flush();

  const seen = new Set();
  const rows = [];
  for (const e of entries) {
    const media  = extractMedia(e.body);
    const prompt = extractPrompt(e.body);
    if (!media || !prompt) continue;            // skip non-prompt sections / malformed
    if (seen.has(media.media_url)) continue;    // dedup
    seen.add(media.media_url);
    rows.push({
      id:            media.media_url,
      provider,
      category:      e.category,
      title:         e.title,
      prompt_text:   prompt,
      source:        extractSource(e.body),
      media_url:     media.media_url,
      media_type:    media.media_type,
      prompt_source: REPO_URL[provider],
      page_url:      media.media_url,
    });
  }
  return rows;
}

async function main() {
  const all = [];
  for (const provider of ['nanobanana', 'seedance']) {
    const md = await readFile(join(RAW_DIR, `${provider}.md`), 'utf-8');
    const rows = parseReadme(md, provider);
    console.log(`${provider}: ${rows.length} prompts`);
    all.push(...rows);
  }
  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify({ prompts: all }, null, 2), 'utf-8');
  console.log(`Total ${all.length} → ${OUT_FILE}`);
}

if (process.argv[1] && process.argv[1].endsWith('prompts-github.js')) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/pipeline && node --test src/parsers/prompts-github.test.js`
Expected: PASS — 5 tests, 0 fail.

- [ ] **Step 5: Add npm script**

In `apps/pipeline/package.json` `scripts`, add:

```json
    "parse:prompts-github": "node src/parsers/prompts-github.js",
```

- [ ] **Step 6: Commit**

```bash
git add apps/pipeline/src/parsers/prompts-github.js apps/pipeline/src/parsers/prompts-github.test.js apps/pipeline/package.json
git commit -m "$(cat <<'EOF'
feat(pipeline): parse nanobanana/seedance READMEs into prompt records

Walks the shared markdown shape (## category → ### title → media → fenced
prompt → source), tags image vs video, dedups by media_url, skips
non-prompt sections. Unit-tested with node:test. Adds parse:prompts-github.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Loader (normalized JSON → prompts)

**Files:**
- Create: `apps/pipeline/src/loaders/prompts-github.js`
- Modify: `apps/pipeline/package.json`

- [ ] **Step 1: Implement the loader**

Create `apps/pipeline/src/loaders/prompts-github.js` (mirrors the existing recipes/prompts loaders, using shared `loadRows`):

```js
/**
 * Loader: data/normalized/prompts-github/prompts.json → prompts table.
 * Idempotent — ON CONFLICT (id) DO NOTHING. No TRUNCATE (the table also
 * holds prompthero rows).  LOAD_LIMIT=N for test mode.
 */
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../lib/db.js';
import { loadRows } from '../lib/loader.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const INPUT_FILE = join(__dirname, '..', 'data', 'normalized', 'prompts-github', 'prompts.json');

const limitArg = process.env.LOAD_LIMIT || process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1];
const LIMIT    = limitArg ? parseInt(limitArg, 10) : null;

const COLUMNS  = ['id', 'provider', 'category', 'title', 'prompt_text', 'source', 'media_url', 'media_type', 'prompt_source', 'page_url', 'posted'];
const CONFLICT = '(id)';

function mapRow(p) {
  return {
    id:            p.id,
    provider:      p.provider,
    category:      p.category ?? null,
    title:         p.title ?? null,
    prompt_text:   p.prompt_text ?? null,
    source:        p.source ?? null,
    media_url:     p.media_url ?? null,
    media_type:    p.media_type ?? null,
    prompt_source: p.prompt_source ?? p.media_url,
    page_url:      p.page_url ?? null,
    posted:        '{}',
  };
}

async function main() {
  const data    = JSON.parse(await readFile(INPUT_FILE, 'utf-8'));
  const prompts = data.prompts ?? data;
  if (!Array.isArray(prompts)) { console.error('Expected "prompts" array'); process.exit(1); }

  let rows = prompts.filter((p) => p.id && p.prompt_text).map(mapRow);
  if (LIMIT) { console.log(`Test mode: first ${LIMIT}`); rows = rows.slice(0, LIMIT); }

  if (!rows.length) { console.log('No prompts to load'); await pool.end(); return; }

  console.log(`Loading ${rows.length} curated prompts`);
  const { inserted, skipped } = await loadRows('prompts', rows, { columns: COLUMNS, conflictTarget: CONFLICT });
  console.log(`Curated prompts — inserted: ${inserted}, skipped: ${skipped}`);
  await pool.end();
  console.log('Done.');
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Add npm scripts**

In `apps/pipeline/package.json` `scripts`, add:

```json
    "load:prompts-github": "node --env-file=../../.env src/loaders/prompts-github.js",
    "load:prompts-github:test": "LOAD_LIMIT=5 node --env-file=../../.env src/loaders/prompts-github.js",
```

- [ ] **Step 3: Syntax check**

Run: `cd apps/pipeline && node --check src/loaders/prompts-github.js`
Expected: exit 0, no output. (Functional DB load is verified in Task 10.)

- [ ] **Step 4: Commit**

```bash
git add apps/pipeline/src/loaders/prompts-github.js apps/pipeline/package.json
git commit -m "$(cat <<'EOF'
feat(pipeline): loader for curated GitHub prompts

Inserts normalized nanobanana/seedance prompts into the prompts table via
the shared loadRows (ON CONFLICT id DO NOTHING). Idempotent, no TRUNCATE.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Filter the existing ai0-prompts repository

**Files:**
- Modify: `apps/automation/src/strategies/ai0-prompts/prompts.repository.ts`

- [ ] **Step 1: Add the provider filter**

In `apps/automation/src/strategies/ai0-prompts/prompts.repository.ts`, change the `getNext` query. Current:

```ts
      `SELECT id, prompt_source, category, status, posted
       FROM prompts
       WHERE category = $1
         AND status IS NULL
         AND NOT (posted ? 'TELEGRAM')
       LIMIT 1`,
```

Replace with (adds the provider guard so prompthero never picks up curated rows):

```ts
      `SELECT id, prompt_source, category, status, posted
       FROM prompts
       WHERE category = $1
         AND provider = 'prompthero'
         AND status IS NULL
         AND NOT (posted ? 'TELEGRAM')
       LIMIT 1`,
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/automation && pnpm run build`
Expected: `nest build` succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/automation/src/strategies/ai0-prompts/prompts.repository.ts
git commit -m "$(cat <<'EOF'
fix(ai0-prompts): only select prompthero rows

getNext now filters provider='prompthero' so the prompthero scraper
strategy never picks up curated GitHub prompts (which have no page to
scrape). Single-line guard.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Publisher `publishVideo`

**Files:**
- Modify: `apps/automation/src/publishers/telegram.publisher.ts`

- [ ] **Step 1: Add the method**

In `apps/automation/src/publishers/telegram.publisher.ts`, add a `publishVideo` method next to `publishPrompt` (mirrors its guard/throttle/logging; streams the video by URL so no large buffer is held):

```ts
  async publishVideo(
    payload: { videoUrl: string; caption: string; replyText?: string },
    target: PublishTarget,
  ): Promise<string> {
    if (this.channelConfig.isPublishPausedFor(target.id)) {
      this.logger.log(`publishVideo(${target.id}) skipped: channel publish_paused=true`);
      throw new ChannelPausedError(target.id);
    }
    this.guardText(payload.caption);
    const { chatId, botToken } = this.channelConfig.resolveChannel(target.id);
    const base = `https://api.telegram.org/bot${botToken}`;

    const res = await axios.post(
      `${base}/sendVideo`,
      { chat_id: chatId, video: payload.videoUrl, caption: payload.caption, parse_mode: 'HTML' },
      { timeout: 60000 },
    );
    const messageId = String(res.data.result.message_id);
    this.throttle.recordPublish(target.id);
    this.logger.log(`Video sent to ${chatId}, message_id: ${messageId}`);

    if (payload.replyText) {
      await this.sendReply(base, chatId, payload.replyText, messageId);
    }
    return messageId;
  }
```

- [ ] **Step 2: Build to verify**

Run: `cd apps/automation && pnpm run build`
Expected: `nest build` succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/automation/src/publishers/telegram.publisher.ts
git commit -m "$(cat <<'EOF'
feat(publisher): add publishVideo (sendVideo by URL)

Streams a video URL to Telegram with caption + optional reply, honoring
the per-channel publish_paused kill switch. Used by curated-prompts for
seedance video prompts.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: CuratedPromptsRepository

**Files:**
- Create: `apps/automation/src/strategies/curated-prompts/curated-prompts.repository.ts`

- [ ] **Step 1: Implement the repository**

Create `apps/automation/src/strategies/curated-prompts/curated-prompts.repository.ts`:

```ts
import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';

export interface CuratedPromptRow {
  id:          string;
  category:    string | null;
  title:       string | null;
  prompt_text: string;
  source:      string | null;
  media_url:   string;
  media_type:  string;   // 'image' | 'video'
}

export interface CuratedFilter {
  provider?:  string;
  mediaType?: string;
}

@Injectable()
export class CuratedPromptsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async getNext(filter: CuratedFilter = {}): Promise<CuratedPromptRow | null> {
    const { rows } = await this.pool.query<CuratedPromptRow>(
      `SELECT id, category, title, prompt_text, source, media_url, media_type
       FROM prompts
       WHERE provider <> 'prompthero'
         AND prompt_text IS NOT NULL
         AND NOT (posted ? 'TELEGRAM')
         AND status IS DISTINCT FROM 'ERROR'
         AND ($1::text IS NULL OR provider   = $1)
         AND ($2::text IS NULL OR media_type = $2)
       ORDER BY created_at
       LIMIT 1`,
      [filter.provider ?? null, filter.mediaType ?? null],
    );
    return rows[0] ?? null;
  }

  async markPosted(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE prompts SET posted = posted || jsonb_build_object('TELEGRAM', NOW()) WHERE id = $1`,
      [id],
    );
  }

  async markError(id: string): Promise<void> {
    await this.pool.query(`UPDATE prompts SET status = 'ERROR' WHERE id = $1`, [id]);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/automation/src/strategies/curated-prompts/curated-prompts.repository.ts
git commit -m "$(cat <<'EOF'
feat(curated-prompts): repository (getNext/markPosted/markError)

getNext returns the oldest unposted curated prompt, filterable by provider
and media_type, excluding prompthero/posted/ERROR rows.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: curated-prompts strategy

**Files:**
- Create: `apps/automation/src/strategies/curated-prompts/curated-prompts.strategy.ts`
- Test: `apps/automation/src/strategies/curated-prompts/curated-prompts.strategy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/strategies/curated-prompts/curated-prompts.strategy.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CuratedPromptsStrategy } from './curated-prompts.strategy';

function row(over = {}) {
  return {
    id: 'm1', category: 'Photorealism & Aesthetics', title: 'Crowd',
    prompt_text: 'Create a hyper-realistic cover.', source: '@seb',
    media_url: 'https://x/i.jpg', media_type: 'image', ...over,
  };
}

function build(over = {}) {
  const calls = { photo: [] as any[], video: [] as any[], posted: [] as string[] };
  const registry = { register() {} };
  const publisher = {
    publishPrompt: async (p: any) => { calls.photo.push(p); return '10'; },
    publishVideo:  async (p: any) => { calls.video.push(p); return '11'; },
  };
  const repo = {
    getNext: async () => ('row' in (over as any) ? (over as any).row : row()),
    markPosted: async (id: string) => { calls.posted.push(id); },
    markError:  async () => {},
  };
  const notifier = { notifyPublished: async () => {} };
  const publications = { insert: async () => {} };
  const s = new CuratedPromptsStrategy(registry as any, publisher as any, repo as any, notifier as any, publications as any);
  (s as any).downloadImage = async () => Buffer.from('img');
  return { s, calls };
}

test('image row → publishPrompt, caption has prompt + hashtag, marks posted', async () => {
  const { s, calls } = build();
  await s.execute('@chan', {});
  assert.equal(calls.photo.length, 1);
  assert.equal(calls.video.length, 0);
  assert.match(calls.photo[0].caption, /hyper-realistic cover/);
  assert.match(calls.photo[0].caption, /#photorealism/i);
  assert.deepEqual(calls.posted, ['m1']);
});

test('video row → publishVideo with the media URL', async () => {
  const { s, calls } = build({ row: row({ id: 'v1', media_type: 'video', media_url: 'https://x/v.mp4' }) });
  await s.execute('@chan', {});
  assert.equal(calls.video.length, 1);
  assert.equal(calls.video[0].videoUrl, 'https://x/v.mp4');
  assert.deepEqual(calls.posted, ['v1']);
});

test('long prompt → short caption + prompt in reply', async () => {
  const long = 'X'.repeat(1200);
  const { s, calls } = build({ row: row({ prompt_text: long }) });
  await s.execute('@chan', {});
  const p = calls.photo[0];
  assert.ok(p.caption.length <= 1024);
  assert.ok(p.replyText && p.replyText.includes(long.slice(0, 50)));
});

test('caption HTML-escapes the prompt', async () => {
  const { s, calls } = build({ row: row({ prompt_text: 'a < b & c > d' }) });
  await s.execute('@chan', {});
  assert.match(calls.photo[0].caption, /a &lt; b &amp; c &gt; d/);
});

test('image download failure → no markPosted', async () => {
  const { s, calls } = build();
  (s as any).downloadImage = async () => { throw new Error('net'); };
  await s.execute('@chan', {});
  assert.equal(calls.posted.length, 0);
});

test('no rows → no-op', async () => {
  const { s, calls } = build({ row: null });
  await s.execute('@chan', {});
  assert.equal(calls.photo.length, 0);
  assert.equal(calls.video.length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/automation && node --import tsx --test src/strategies/curated-prompts/curated-prompts.strategy.test.ts`
Expected: FAIL — cannot find module `./curated-prompts.strategy`.

- [ ] **Step 3: Implement the strategy**

Create `apps/automation/src/strategies/curated-prompts/curated-prompts.strategy.ts`:

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import { ContentStrategyRegistry } from '../../common/content-strategy/content-strategy.registry';
import { TelegramPublisher }       from '../../publishers/telegram.publisher';
import { TelegramNotifier }        from '../../publishers/telegram-notifier.service';
import { PublicationsRepository }  from '../../stats/publications.repository';
import { Skill }                   from '../../common/ai/skills/skill.interface';
import {
  ContentStrategy, StrategyFetchResult, StrategyPost, StrategyParams,
} from '../../common/content-strategy/content-strategy.interface';
import { CuratedPromptsRepository, CuratedPromptRow } from './curated-prompts.repository';

const CAPTION_MAX = 1024;
const REPLY_MAX   = 4096;
const USER_AGENT  =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hashtag(category: string | null): string {
  if (!category) return '';
  return '#' + category.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

@Injectable()
export class CuratedPromptsStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(CuratedPromptsStrategy.name);
  readonly type = 'curated-prompts';

  constructor(
    private readonly registry:     ContentStrategyRegistry,
    private readonly publisher:    TelegramPublisher,
    private readonly repo:         CuratedPromptsRepository,
    private readonly notifier:     TelegramNotifier,
    private readonly publications: PublicationsRepository,
  ) {}

  onModuleInit() { this.registry.register(this); }

  getSkills(_params: StrategyParams): Skill[] { return []; }
  async fetch(): Promise<StrategyFetchResult | null> { return null; }
  async generate(): Promise<StrategyPost | 'SKIP_POST' | null> { return null; }

  async execute(channelId: string, params: StrategyParams): Promise<void> {
    const p = (params ?? {}) as { provider?: string; mediaType?: string };
    const row = await this.repo.getNext({ provider: p.provider, mediaType: p.mediaType });
    if (!row) { this.logger.debug('No unposted curated prompts'); return; }

    const { caption, replyText } = this.buildMessage(row);

    try {
      let messageId: string;
      if (row.media_type === 'video') {
        messageId = await this.publisher.publishVideo(
          { videoUrl: row.media_url, caption, replyText }, { id: channelId },
        );
      } else {
        const imageBuffer = await this.downloadImage(row.media_url);
        messageId = await this.publisher.publishPrompt(
          { imageBuffer, caption, replyText: replyText || undefined }, { id: channelId },
        );
      }
      await this.repo.markPosted(row.id);
      await this.notifier.notifyPublished(channelId, messageId);
      await this.publications.insert({
        channelId, messageId,
        sourceUrl:    row.media_url,
        title:        (row.title ?? row.prompt_text).slice(0, 200),
        strategyType: this.type,
        tags:         row.category ? [row.category] : [],
      });
      this.logger.debug(`Published curated prompt ${row.id} to ${channelId}`);
    } catch (err: any) {
      this.logger.error(`Publish failed (${row.id}): ${err.message}`);
      // no markPosted — retried next run
    }
  }

  /** Caption mirrors the ai0-prompts format; long prompt overflows to reply. */
  private buildMessage(row: CuratedPromptRow): { caption: string; replyText?: string } {
    const title = row.title ? `<b>${escapeHtml(row.title)}</b>` : '';
    const tag   = hashtag(row.category);
    const src   = row.source ? `👤 ${escapeHtml(row.source)}` : '';
    const promptBlock = `💬 Prompt:\n<code>${escapeHtml(row.prompt_text)}</code>`;

    const full = [title, promptBlock, [src, tag].filter(Boolean).join('\n')]
      .filter(Boolean).join('\n\n');

    if (full.length <= CAPTION_MAX) return { caption: full };

    // Overflow: short caption + prompt in the reply.
    const caption = [title, tag].filter(Boolean).join('\n\n') || '💬 Prompt';
    let reply = [promptBlock, src].filter(Boolean).join('\n\n');
    if (reply.length > REPLY_MAX) reply = reply.slice(0, REPLY_MAX - 1) + '…';
    return { caption, replyText: reply };
  }

  private async downloadImage(url: string): Promise<Buffer> {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15_000,
    });
    return Buffer.from(res.data);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/automation && node --import tsx --test src/strategies/curated-prompts/curated-prompts.strategy.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/strategies/curated-prompts/curated-prompts.strategy.ts apps/automation/src/strategies/curated-prompts/curated-prompts.strategy.test.ts
git commit -m "$(cat <<'EOF'
feat(curated-prompts): DB-backed strategy (image + video)

execute() pulls the next unposted curated prompt (filtered by binding
params provider/media_type), builds a verbatim caption mirroring
ai0-prompts (prompt in <code>, category hashtag, source), and publishes:
image via publishPrompt, video via publishVideo. Long prompts overflow to
a reply. No Claude. Unit-tested with fakes (no network).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Module wiring

**Files:**
- Create: `apps/automation/src/strategies/curated-prompts/curated-prompts-strategy.module.ts`
- Modify: `apps/automation/src/app.module.ts`

- [ ] **Step 1: Create the module**

Create `apps/automation/src/strategies/curated-prompts/curated-prompts-strategy.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { CuratedPromptsStrategy }   from './curated-prompts.strategy';
import { CuratedPromptsRepository } from './curated-prompts.repository';

@Module({
  providers: [CuratedPromptsStrategy, CuratedPromptsRepository],
  exports:   [CuratedPromptsStrategy],
})
export class CuratedPromptsStrategyModule {}
```

- [ ] **Step 2: Register in app.module.ts**

In `apps/automation/src/app.module.ts`, add the import next to the other strategy-module imports (after the `Ai0PromptsStrategyModule` import line):

```ts
import { CuratedPromptsStrategyModule } from './strategies/curated-prompts/curated-prompts-strategy.module';
```

And add `CuratedPromptsStrategyModule,` to the `imports: [ … ]` array next to `Ai0PromptsStrategyModule,`.

- [ ] **Step 3: Build + full test suite**

```bash
cd apps/automation && pnpm run build
node --import tsx --test "src/**/*.test.ts" 2>&1 | grep -E "# (tests|pass|fail)"
```

Expected: `nest build` succeeds; all tests pass (existing + the new curated-prompts test).

- [ ] **Step 4: Commit**

```bash
git add apps/automation/src/strategies/curated-prompts/curated-prompts-strategy.module.ts apps/automation/src/app.module.ts
git commit -m "$(cat <<'EOF'
feat(curated-prompts): register module in app

Wires CuratedPromptsStrategyModule into the app so the strategy
self-registers. nest build + full test suite green.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Integration verify (fetch + parse + load; cost-safe)

**No code changes.** Confirms the pipeline end-to-end and the repository SQL. The fetch step hits the network (GitHub READMEs only) — no Claude, no Telegram.

- [ ] **Step 1: Fetch + parse**

```bash
cd apps/pipeline
pnpm run scrape:prompts-github
pnpm run parse:prompts-github
head -c 700 src/data/normalized/prompts-github/prompts.json
```

Expected: parse prints per-provider counts (~95 nanobanana + ~45 seedance) and a total; JSON has a `prompts` array with `provider/media_type/prompt_text/media_url`.

- [ ] **Step 2: Load (capped first, then full)**

```bash
cd apps/pipeline && LOAD_LIMIT=10 pnpm run load:prompts-github
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c \
  "SELECT provider, media_type, count(*) FROM prompts WHERE provider <> 'prompthero' GROUP BY 1,2;"
pnpm run load:prompts-github      # full
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c \
  "SELECT provider, count(*) FROM prompts GROUP BY provider;"
```

Expected: curated rows appear with image/video split; prompthero rows untouched. Re-running is idempotent (`skipped` grows, count stable).

- [ ] **Step 3: Verify repository SQL by hand**

```bash
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c \
  "SELECT id, media_type FROM prompts WHERE provider='nanobanana' AND NOT (posted ? 'TELEGRAM') AND status IS DISTINCT FROM 'ERROR' ORDER BY created_at LIMIT 1;"
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c \
  "SELECT id, media_type FROM prompts WHERE provider='seedance' AND media_type='video' AND NOT (posted ? 'TELEGRAM') ORDER BY created_at LIMIT 1;"
```

Expected: a nanobanana image row and a seedance video row are returned.

- [ ] **Step 4: Confirm cost-safe posture**

```bash
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c \
  "SELECT ext_id, type, enabled FROM strategy_bindings WHERE type='curated-prompts';"
```

Expected: no enabled `curated-prompts` binding on the local/dev config (don't bind during development — no posting, no Telegram). The existing `ai0-prompts` strategy continues to work, now filtered to prompthero rows.

---

## Self-Review

**Spec coverage:**
- Extend prompts table (provider/title/prompt_text/source/media_url/media_type) → Task 1 ✅
- Fetch READMEs → Task 2 ✅
- Parser (markdown → records, image vs video, categories as-is, dedup) → Task 3 ✅
- Loader (ON CONFLICT id, idempotent) → Task 4 ✅
- ai0-prompts provider filter → Task 5 ✅
- publishVideo (sendVideo) → Task 6 ✅
- CuratedPromptsRepository (getNext filter / markPosted / markError) → Task 7 ✅
- curated-prompts strategy (verbatim format, image→publishPrompt, video→publishVideo, params filter, long→reply) → Task 8 ✅
- Module wiring → Task 9 ✅
- id = media_url → Tasks 3/4/7 ✅
- Cost-safe testing + unbound strategy → Tasks 3/8 (no network), Task 10 step 4 ✅

**Placeholder scan:** none — every code/command step is concrete.

**Type consistency:** `CuratedPromptRow` fields (`id, category, title, prompt_text, source, media_url, media_type`) match across Task 7 (repo), Task 8 (strategy + test fakes). `getNext({ provider, mediaType })` signature matches between Task 7 and Task 8. `publishVideo({ videoUrl, caption, replyText })` matches between Task 6 (definition) and Task 8 (call). `publishPrompt({ imageBuffer, caption, replyText })` matches the existing publisher. Loader `COLUMNS` match the migration's new columns + existing `prompts` columns. The parser's normalized keys (`id, provider, category, title, prompt_text, source, media_url, media_type, prompt_source, page_url`) match the loader's `mapRow` inputs.
