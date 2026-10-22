# 065 — Document reader and list import

Status: done · Builds on 053 (tool result cap), 058 (data store, `data_items_upsert`, `data_imports` undo), 083 (`post_requires`) · No migration unless the data store needs one

## Why

On 2026-10-22 the owner told @ai0_prompts_dev to stop using PromptHero and post from https://github.com/ZeroLu/awesome-nanobanana-pro. The agent wrote a skill but could not make a single test post. It reported two problems: prompts were cut (`[cut 3470 chars]`) and there were «10 images without binding to entries».

The source is ideal for this channel. The raw README is 100,511 chars and holds 72 entries, each with the same structure:

```
### 1.1. Hyper-Realistic Crowd Composition
*description*
<img … src="https://github.com/user-attachments/assets/…" />
**Prompt:**
```text … full prompt … ```
*Source: [@SebJefferies](https://x.com/…)*
```

The two problems come from our tools, not from the source:

1. **One shot, 8 KB.** `web_fetch` returns one result capped by `toToolContent` at `TOOL_RESULT_MAX_CHARS = 8_000` (`harness/truncate.ts`). The longest string is cut in the middle, so the agent sees about 8% of the document and has no way to read the rest.
2. **An article extractor on structured text.** `extractPage` (`net/extract-page.ts`) is built for HTML articles. On a markdown file it collapses whitespace, loses code-block boundaries, cuts at `TEXT_MAX`, and returns `images` as a flat list with no position. The heading → image → prompt → source binding is lost, although it is unambiguous in the file.
3. **Browsing per slot is the wrong model for a library.** A list source should be imported once into the data store and then queried per slot (`query_data`, ledger, `post_requires`, 061 pre-flight, 060 pause), not re-downloaded and re-read by the LLM every slot.

Raising the cap is not the answer: it pays for 100 KB of tokens on every read and still cuts larger pages. The answer is to read like a file (an outline, then the needed part) and to let code extract records.

## What

### FR-001 Document store and reader tools

- **`web_fetch` keeps the whole document.** It keeps the full fetched body in a `DocStore`: in memory, LRU of about 100 docs, TTL `DOC_STORE_HOURS` (default 6). Successful fetches only. This doubles as the fetch cache: a second `web_fetch` of the same canonical URL within the TTL is served from the store with `cached: true`. (This replaces 061 FR-005.)
- **When the document is large.** If the extracted text is longer than about 6,000 chars, or the document has more than one section, `web_fetch` still returns `title`, `description`, `image` and `published_at`, plus:
  - `doc_id`;
  - `size_chars`;
  - an `outline`: up to 80 sections, each with `{ id, heading, level, chars, code_blocks, images }`;
  - the first chunk of text (about 3,000 chars);
  - a hint: «решта — read_doc(doc_id, section|from) або find_in_doc(doc_id, query)».

  Small pages keep today's shape, so nothing changes for news fact-checks.
- **`read_doc({ doc_id, section?, from?, max_chars? })`** returns one section, or a char range, up to `max_chars` (default and maximum 6,000). It never cuts inside a code block: it stops before one, or includes it whole if it fits. It returns `next_from` when there is more.
- **`find_in_doc({ doc_id, query, limit? })`** returns matching snippets (±300 chars) with their section ids. The match is case-insensitive substring or simple word matching.
- **Who gets the tools.** Both are read tools for all roles that have `web_fetch`. Add them to the 054 loadout catalogue as part of the `web_fetch` family.
- **Expired `doc_id`.** It returns `doc_expired` with the URL, so the agent calls `web_fetch` again.

### FR-002 Structure-aware parsing

- **GitHub URLs.**
  - `github.com/<owner>/<repo>` (with an optional `/tree/<branch>`) is fetched as the raw README of the default branch. Try `main`, then `master`.
  - `github.com/<owner>/<repo>/blob/<branch>/<path>` is fetched as `raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>`.
  - The original URL stays as `url` and the raw one is `fetched_url`.
- **Markdown parsing.** Markdown (by content type `text/markdown` / `text/plain` with an `.md` path, or a raw GitHub URL) is parsed as markdown, not as HTML. Each section (by heading) keeps, in document order:
  - its text with newlines;
  - fenced code blocks, whole, with their language;
  - images (markdown `![alt](src)` and inline `<img src>`), each with its section id;
  - links.
- **HTML pages.** HTML keeps `extractPage`. Its `images` gain the id of the section they sit in when headings exist.

### FR-003 `import_list` — a list source becomes dataset rows (card-first)

- **Extraction, in code.** A builder/composer chat tool `import_list({ doc_id, dataset, mapping, filter?, sample? })`. Code extracts one record per section of a chosen heading level. `mapping` maps dataset fields to extractors:
  - `heading`;
  - `first_code_block`;
  - `first_image`;
  - `first_paragraph`;
  - `link_after:<label>`, e.g. `link_after:Source` → url, with the text as author;
  - `regex:<pattern>` over the section text;
  - `const:<value>`.

  `filter` drops sections, e.g. a heading regex, or "has a code block", or "not containing Sponsor".
- **Preview.** The tool first returns a preview: the count, 3 sample rows and per-field fill %. Nothing is written yet.
- **Card.** Then it creates an **Apply card** (the existing pending-actions path). On Apply, the rows go through the data store (`data_items_upsert` / the 058 import path) as a `data_imports` row, so the dashboard undo works.
- **Dataset.** The dataset is created if missing, with `post_requires`. For prompts the required fields are `prompt_text` and `media_url`. Dedup is by source URL plus heading (stable `ref`).
- **License.** A `license` field (e.g. `CC BY 4.0`) and `author` / `source_url` are stored per row. The channel's caption attribution reads them.
- **Re-sync.** The import stores its `{ url, mapping, filter }`. `resync_import(dataset)` (and a weekly code job) re-fetches and upserts new or changed entries, also through a card the first time and silently afterwards (owner setting `IMPORT_RESYNC_AUTO`, default on after the first Apply).

### FR-004 Executor uses the dataset, not the web

The skill path for a library channel stays as today: `query_data` and `search_library` on the dataset. The executor prompt and tool description say: «бібліотечний контент бери з датасету; web_fetch — лише для перевірки».

### FR-005 First real use: nanobanana

- **Fixture.** A test fixture with a trimmed copy of the README structure (5 entries, including a JSON prompt, a sponsor block and an entry without an image) must give exactly the expected records: title, full prompt with newlines, the image of that entry, author and source URL. The sponsor block and the entry without an image must not become postable rows.
- **Runbook.** The runbook section says how the owner runs it after deploy. In @ai0_prompts_dev chat:
  - «імпортуй https://github.com/ZeroLu/awesome-nanobanana-pro у датасет nanobanana_prompts» → the preview → Apply.
  - Then point the channel's skill or series at the dataset. The agent's `nanobanana-github-prompt-post` skill (written 10-22) needs a one-line update: «рядки з датасету nanobanana_prompts».

## Acceptance

- Unit tests:
  - DocStore (LRU, TTL, cache hit);
  - `web_fetch` large vs small shape;
  - `read_doc` paging, including never cutting a code block;
  - `find_in_doc`;
  - GitHub URL mapping;
  - the markdown parser with section/image/code binding;
  - `import_list` preview and mapping extractors;
  - the card payload.
- A PG test that applies an import into a throwaway dataset with `post_requires` and checks the postable count and undo.
- No network in tests: inject the HTTP getter.
