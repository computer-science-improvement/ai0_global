# 061 tasks

- [x] T1 Migration 094 (+ down) for the ledger anchor (and `strikes` on `source_host_failures` if needed); `LEDGER_REUSABLE_HOSTS` setting; reusable-host ledger key with `source.anchor` (post spec field, tool descriptions); `source_already_posted` with details + remedy in role tools; unit + PG tests.
- [ ] T2 Pre-flight before the executor: ledger / freshness / host block / `formatAvailable` checks, one idea swap, `preflight_*` skip codes classified in `skip-reasons.ts`; `settleIdea` by outcome; unit + PG tests.
- [ ] T3 Host strikes 1 d → 3 d → 7 d, timeouts as 1 h failures, source health over card + playbook feeds, one owner note/card after 3 strikes (change_source path); `web_fetch` URL cache (`WEB_FETCH_CACHE_HOURS`); tests.
- [ ] T4 Expired tokens: mark `token_expires_at` on expired-session errors, keeper counts expired, collector daily backoff for token_invalid accounts; tests; docs (runbook §, specs README row 061 DONE, spec status done).
