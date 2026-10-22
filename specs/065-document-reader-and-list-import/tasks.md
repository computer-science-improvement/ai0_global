# 065 tasks

- [x] T1 DocStore (LRU, TTL `DOC_STORE_HOURS`, fetch cache); `web_fetch` large-document shape (doc_id, outline, first chunk) with small pages unchanged; `read_doc` and `find_in_doc` tools (loadout catalogue); unit tests.
- [x] T2 GitHub URL → raw mapping; markdown parser (sections, whole code blocks, images and links bound to sections); HTML images get section ids; unit tests incl. the nanobanana fixture.
- [x] T3 `import_list` (preview → Apply card → data store import with undo, dataset created with `post_requires`, license/author/source fields, stable refs), `resync_import` + weekly job; executor prompt line; PG test; docs (runbook § 24 with the nanobanana steps, specs README row 065 DONE, spec status done).

## Status

- T1 done — DocStore, large-document shape of `web_fetch`, `read_doc`, `find_in_doc` (one commit, see `git log`).
- T2 done — GitHub URL → raw mapping, markdown parser, HTML section ids, the nanobanana fixture (one commit, see `git log`).
- T3 done — `import_list` / `resync_import`, the two card kinds, the weekly job, PG test, runbook § 24, spec status done (one commit, see `git log`).

## Deltas from the spec

- T1: a short HTML page keeps today's shape. A large HTML page is one whose full text is over ~6,000 chars; the «more than one section» test applies to markdown files only (a news article with a few subheadings must not change shape). Hence `LARGE_DOC_CHARS` = `TEXT_MAX`.
- T1: `web_fetch` has its own result cap (`maxResultChars` 14,000) and `read_doc` 20,000 (053 FR-003 lets a tool say so): an outline of 80 sections plus a first chunk does not fit 8,000, and a whole code block may come past `max_chars`.
- T1: the outline's `code_blocks` and `images` are counts; the images themselves (with alt) come with the text in `read_doc`.
- T1: the doc_id is a hash of the canonical address (`doc_<10 hex>`), stable across re-fetches; a small tombstone map keeps the address of a gone doc_id so `doc_expired` can name the URL.
- T1: `read_doc` / `find_in_doc` follow `web_fetch` in the loadout through `TOOL_FAMILIES` (`loadout/tool-families.ts`: core of a new loadout, and added to a stored custom one) instead of editing the role profiles. The idea reviewer does not get them (its tool set is fixed by `IDEA_REVIEW_TOOLS`).
- T2: «HTML images gain the id of their section» is done as `sections[].images` of the stored document (read through `read_doc`, `images` with `alt`); the flat `images` list of an HTML page is unchanged, so nothing that reads it breaks.
- T2: the GitHub README is looked up as `README.md` only (not `readme.md` / `README.rst`), `main` then `master`; `/tree/<branch>/<subpath>` and other GitHub pages (issues, pulls, gists) are fetched as normal HTML. A repository whose README does not exist falls back to fetching the page itself.
- T2: an `<img>` tag in markdown is rewritten to `![alt](src)` in the stored text (so a 70-entry list reads as one form); relative image and link addresses are resolved against the fetched file's address. A badge link (`[![badge](…)](target)`) has no words and is not recorded as a link.
- T2: plain text that is not markdown is kept as one section with its newlines (it used to pass through the HTML extractor, which collapsed them); for a markdown file `web_fetch.image` is the first picture that is not a badge and `images` is left out of the large shape (the pictures belong to sections).
- T1: the web_fetch tool description carries the FR-004 line («бібліотечний контент бери з датасету; web_fetch — лише для перевірки»); the executor workflow skill is at its size limit (skills audit), so the line is not added there. The same sentence is appended to the `query_data` description.
- T3: the `heading` extractor strips the outline number («1.1. Title» → «Title»); `heading_raw` keeps it. The mapping language has more extractors than the spec lists, because the real README needs them: `last_image` / `image:<n>` (an entry shows the input and the result picture; the result is the last), `link_text_after:` / `last_link_after:` / `line_after:` (author name and post link both sit on one Source line), `code_block:<n>`, `first_paragraph`, `regex:`, `const:`. Badge images are never picked.
- T3: `list_ref` (page address + normalised heading, « (n)» for a repeated heading) is the dedup key of a created dataset; it is a hidden field (`agent_visible` false) beside `list_url`. An existing dataset must have `list_ref` or a mapped dedup key (`no_dedup`).
- T3: the entry level is found from where the code blocks / pictures are (`level` overrides). Rows missing a field of `post_requires` are not written (reported as «not postable»); the default required set is the fields read by `heading`, `code_block` and image extractors, so author and source stay optional.
- T3: the Apply card carries the mapping, filter, level and the schema to create, not the rows: Apply fetches the page again and extracts again (the same code as the preview, so the rows are the same unless the page changed, and `expected` is only a check). The list information is stored in `options.list_import` of the `data_imports` row (the `source` CHECK allows only `api` for `importRows`).
- T3: `resync_import` is silent only for a list whose first import the owner applied (`auto_resync` on that import row) and while `IMPORT_RESYNC_AUTO` is on; otherwise it proposes a `resync_import` card (a second card kind). A re-sync that changed nothing deletes its own empty import row, so the dataset page does not fill with no-op imports. The weekly job (Monday 04:20 Kyiv) does the same for every auto list.
- T3: `import_list` is for the composer and builder in chat only (`chatOnly`); it refuses with `already_pending` when a card for the same page and dataset waits.
- T3: the «executor prompt line» of the task list is the sentence in the tool descriptions (see the T1 delta); the skill `nanobanana-github-prompt-post` lives in the database, so the runbook asks the owner to add one line to it in the dashboard.
- T3: no migration was needed. `DOC_STORE_HOURS` also reads `process.env` (the settings overlay runs before the app is built), because the document store is created by whoever asks first.
