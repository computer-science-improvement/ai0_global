# 066 tasks

- [x] T1 JSON documents: `fetchDocument` accepts JSON (types + plain body that parses), `kind: 'json'` with parsed value, records array found, one section per record (+ intro of root scalars), `web_fetch` JSON answer with the `json` shape block (records_path, root scalars, fields with fill/sample, pagination when detected) and small-JSON whole answer, `detectPagination` (pure), `read_doc` / `find_in_doc` / outline over records, tool descriptions; unit tests.
- [ ] T2 `import_list` over JSON: `field:` / `first_of:` / `const:` / `regex:` extractors, `where` / `has` / `not_containing` filters, `wrong_extractor` both ways, stable refs by id, default required, filterable `type`/`kind`/`category`; page loop for Apply (fresh, host guard, delay, not stored, `pages` arg, `IMPORT_MAX_PAGES` / `IMPORT_MAX_ROWS` settings, partial import on a failing page with the card outcome), preview with page/record totals; incremental re-sync for paged sources (manual + weekly job); untrusted-data line in tool descriptions; prompts.chat two-page fixture; unit + PG tests; docs (runbook § 25 with the owner steps, specs README row 066 DONE, spec status done).

## Status

- T1 done — JSON documents in the reader: `fetchDocument` accepts JSON, `kind: 'json'` with records as sections, the `web_fetch` JSON answer (shape, pagination, first record), `detectPagination`, tool description, the prompts.chat two-page fixture (one commit, see `git log`).
