# 070 tasks

- [x] T1 `import_list` `split_on`: `splitEntries`, keyed refs, extractors `split_key` / `url_anchor:` / `text` / `text_without:` / `context_line:`, defaults, preview notes, stored for re-sync, row cap; pdr fixture; unit + PG tests.
- [ ] T2 Network: `classifyTransient` with one retry recorded as `timeout`, feed scoping (`blocked` for feeds, `feed_refused` / `feed_missing` on the feed key, flat 24 h), source-health mirror; DocStore stale copies (`get` TTL-free within 168 h, `fresh`, `keptByUrl`), stale-if-error in `fetchDocument` and the `web_fetch` answer; tests.
- [ ] T3 Quiz inference with the inferred cap and dashboard placeholder; Meta consecutive-400 back-off and `graphErrorText`; story_repeat bypass on strong evidence only; tests.
- [ ] T4 Ops: restart line removed from deploy-develop.yml and release-prod.yml, boot-time SIGTERM/SIGINT handler in main.ts; docs (runbook § 29 with the pdr owner steps and the `init: true` owner action, specs README row 070 DONE, spec status done).

## Status

- T1 — done (commit `070 T1`)

## Deltas from the spec

- FR-001 tests live in new files (`docs/import-list-split.test.ts`, `docs/import-list-split.pg.test.ts`) next to `docs/testing/pdr-fixture.ts`, not in `import-list.test.ts`, so that 069 (which edits the same test file) merges without conflicts.
- FR-001: `text` and `text_without:` count as content for every markdown import (`CONTENT`), `heading` stops counting only with `split_on` (`SPLIT_CONTENT`, amendment A3).
- FR-001: the heading of a record drops markdown `#` markers when the matching line is a markdown heading; for an HTML or text page it is the line as it is.
- FR-001: `url_anchor:` with an empty prefix is allowed (the anchor is the bare key). A pattern with no group gives records with no key: `split_key` and `url_anchor` are empty and the ref falls back to the heading (`refOf`), as for any other list.
- FR-001: `split_on` that matches no line is `no_entries` («split_on matches no line of the document…»), not an empty preview. `context_line:` patterns that fail to compile are `bad_pattern`, like `split_on`.
- FR-001: the preview shows `records`, `longest_record_chars` and `repeated_keys` at the top level of the preview object (not under a `split` key), and repeated keys also add a plan note.

