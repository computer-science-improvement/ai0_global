# 070 tasks

- [x] T1 `import_list` `split_on`: `splitEntries`, keyed refs, extractors `split_key` / `url_anchor:` / `text` / `text_without:` / `context_line:`, defaults, preview notes, stored for re-sync, row cap; pdr fixture; unit + PG tests.
- [x] T2 Network: `classifyTransient` with one retry recorded as `timeout`, feed scoping (`blocked` for feeds, `feed_refused` / `feed_missing` on the feed key, flat 24 h), source-health mirror; DocStore stale copies (`get` TTL-free within 168 h, `fresh`, `keptByUrl`), stale-if-error in `fetchDocument` and the `web_fetch` answer; tests.
- [ ] T3 Quiz inference with the inferred cap and dashboard placeholder; Meta consecutive-400 back-off and `graphErrorText`; story_repeat bypass on strong evidence only; tests.
- [ ] T4 Ops: restart line removed from deploy-develop.yml and release-prod.yml, boot-time SIGTERM/SIGINT handler in main.ts; docs (runbook § 29 with the pdr owner steps and the `init: true` owner action, specs README row 070 DONE, spec status done).

## Status

- T1 — done (commit `070 T1`)
- T2 — done (commit `070 T2`)

## Deltas from the spec

- FR-001 tests live in new files (`docs/import-list-split.test.ts`, `docs/import-list-split.pg.test.ts`) next to `docs/testing/pdr-fixture.ts`, not in `import-list.test.ts`, so that 069 (which edits the same test file) merges without conflicts.
- FR-001: `text` and `text_without:` count as content for every markdown import (`CONTENT`), `heading` stops counting only with `split_on` (`SPLIT_CONTENT`, amendment A3).
- FR-001: the heading of a record drops markdown `#` markers when the matching line is a markdown heading; for an HTML or text page it is the line as it is.
- FR-001: `url_anchor:` with an empty prefix is allowed (the anchor is the bare key). A pattern with no group gives records with no key: `split_key` and `url_anchor` are empty and the ref falls back to the heading (`refOf`), as for any other list.
- FR-001: `split_on` that matches no line is `no_entries` («split_on matches no line of the document…»), not an empty preview. `context_line:` patterns that fail to compile are `bad_pattern`, like `split_on`.
- FR-001: the preview shows `records`, `longest_record_chars` and `repeated_keys` at the top level of the preview object (not under a `split` key), and repeated keys also add a plan note.
- FR-002: `feedKey` itself returns `host/` for a feed at the root of the site (amendment A1), so every consumer (fetch_feed, source health, source change, the playbook feeds) agrees on the key and the `struck()` query, which skips keys with a `/`, never sees a feed row. A reset in `fetch_feed` is recorded on the host as `timeout`, a feed's own refusal or absence on the feed key.
- FR-002: the retry is `retryReset(get, ms = RESET_RETRY_MS)` in `net/host-failures.ts`. `ReadToolDeps.retryMs`, `FetchDocDeps.retryMs` (also `fetchJsonPage` / `readPages`) and a fifth parameter of `fetchPageGuarded` carry it for the tests; `extract_images` keeps the 1 s default (no seam, no test needs one). A reset is not retried when it is a DNS / TLS / timeout error.
- FR-002: the feed answers that record a block also say so to the agent («Цю адресу не читай добу»); a 500 or any other status is still not recorded. 400 is `feed_missing`, as the spec says.
- FR-002 changed on purpose: `host-failures.test.ts` (the `socket hang up` throw and the `MemoryHosts` double, now the new rule), `host-strikes.061.test.ts` (the flaky `socket hang up` rejection, and the second-strike case, now a `url` source plus a feed behind a DNS block), `host-strikes.061.pg.test.ts` (the playbook feed whose host answered pages with 403 is now `unused`; the feed's own `feed_refused` is `blocked` with no strike and no second owner note), `import-list-json.test.ts` (a reset on page 2 now ends the run with the reset text; a generic error still ends it with its message).
- FR-003: `DocStore` gets `staleHours` (default `DOC_STALE_MAX_HOURS` = 168, never below the lifetime) as an option for tests; no setting. `fresh()` / `keptByUrl()` touch the LRU order only when they return a copy. `read_doc` / `find_in_doc` answers do not say that the copy is stale (only `web_fetch` does); the `web_fetch` tool description and the `DOC_STORE_HOURS` / `IMPORT_MAX_ROWS` setting help now mention the stale copy and the split cut.
- FR-003: `webFetchAnswer(doc, cached, stale?)` adds `stale: true`, `fetched_at` (ISO) and `note` («копія від YYYY-MM-DD HH:MM UTC; сайт зараз недоступний») on both the document path and the early `jsonAnswer` path. `FetchedDoc.stale.reason` is the failure code, or `status N`.
- Changed on purpose, FR-003: `doc-store.test.ts` (the TTL test now pins `fresh` vs `get` and the 168 h cap) and `doc-tools.test.ts` (`doc_expired` after eviction or past 168 h, not 7 h after a 6 h TTL). New: `docs/doc-stale.070.test.ts`.

