# 070 tasks

- [ ] T1 `import_list` `split_on`: `splitEntries`, keyed refs, extractors `split_key` / `url_anchor:` / `text` / `text_without:` / `context_line:`, defaults, preview notes, stored for re-sync, row cap; pdr fixture; unit + PG tests.
- [ ] T2 Network: `classifyTransient` with one retry recorded as `timeout`, feed scoping (`blocked` for feeds, `feed_refused` / `feed_missing` on the feed key, flat 24 h), source-health mirror; DocStore stale copies (`get` TTL-free within 168 h, `fresh`, `keptByUrl`), stale-if-error in `fetchDocument` and the `web_fetch` answer; tests.
- [ ] T3 Quiz inference with the inferred cap and dashboard placeholder; Meta consecutive-400 back-off and `graphErrorText`; story_repeat bypass on strong evidence only; tests.
- [ ] T4 Ops: restart line removed from deploy-develop.yml and release-prod.yml, boot-time SIGTERM/SIGINT handler in main.ts; docs (runbook § 29 with the pdr owner steps and the `init: true` owner action, specs README row 070 DONE, spec status done).
