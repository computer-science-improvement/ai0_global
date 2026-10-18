# 049 Ops autonomy — tasks

- [x] T1 (AI0-221) Connection keeper: `config/connection-keeper.ts` holds the logic, with every port injected. `config/connection-keeper.upkeep.ts` is the cron at 05:40 and is disabled by `CONNECTION_KEEPER=off`.
  - Threads tokens are refreshed 10 days before expiry, or when the expiry is unknown, and stored encrypted with the new expiry.
  - An expired token is stated with the date in `verify_error`.
  - `debug_token` metadata is stored for Facebook and Instagram.
  - Bots and Telegraph accounts are verified with one retry and get one Inbox note a day while broken.
  - TikTok tokens are kept fresh.
  - MTProto sessions are reported from stored state.
  - The catalog reads `token_expires_at` and `token_valid`:
    - an expired or invalid token → `token_invalid` ("token expired on D");
    - a token expiring within 7 days → `token_expiring` ("N d left").
- [x] T2 (AI0-222) Repeat alerts and skipped slots:
  - `ResourceHealthService` keeps `since`, `expiresAt` and `dismissedAt`.
  - It posts a daily reminder (`resource_health_daily`, dedup `resource_day`), a recovery note (`resource_health_ok`) and `blocked(ref)` with a 30-minute re-check.
  - The scheduler skips due slots on a blocking resource with `resource_unavailable: …`, and the plan shows "Connection broken".
  - New endpoint: `POST /api/agents/:handle/health/dismiss`.
  - `ConnectionBanner` on the agent page.
  - Tests: `editor/platform/ops-health.049.test.ts` and `config/connection-keeper.049.test.ts`.
- [x] T3 (AI0-223) Source health per resource: `editor/sources/source-health.ts` (pure) and its repository read 14 days of the run trace (`editor_run_steps`) and `source_host_failures`.
  - A source is matched by the tool that reads it: rss → `fetch_feed` of that feed address, url → page tools on that host, api → `fetch_api` of that source, library → `query_data` / `search_library` of that dataset.
  - States: blocked (an active host or feed block), failing (3+ errors under 50 % success, or the last 3 calls failed), exhausted (the last 3 reads returned nothing), ok, unused.
  - Per source: the success rate, the last good read, the last error, the block and the slots lost (an errored read, no good read in that slot, the slot skipped or failed).
  - `GET /api/agents/:handle/sources`; the "Sources" section on a Telegram orchestrator's overview, with the blocked sites its runs hit outside the card.
- [x] T4 (AI0-224) Replacement source proposals:
  - Tools `get_source_health` (read) and `propose_source_change` (act; replace, add or remove). The candidate is read before the owner sees it: a blocked host, an empty or stale feed (newest item over 30 days), an HTTP error, an empty API or an unknown or empty dataset is refused.
  - The change is a pending action `change_source` (Apply / Discard in "Waiting for you"). Apply changes the card as it is now; a replacement keeps the source id.
  - The orchestrator's daily run gets a block with the sources to replace; a failing source counts as work, so the no-LLM skip of spec 053 does not hide it.
  - Each source is asked about at most weekly, with one owner Inbox note (`source_failing`). A source with a card waiting, or one the owner discarded within 7 days, is left out.
  - Tests: `editor/sources/sources.049.test.ts`.
- [x] T5 (AI0-225) Network health view and weekly report section:
  - `GET /api/network-health` (`editor/health/`): bad connections (`resource_profiles.resource_health`), troubled sources of every active card, today's budget lines (the Spend snapshot, `budgetSnapshot`, shared with the Budgets tab) with the slots a cap held back, and stuck work.
  - Stuck work: runs over 30 min, planned posts 30 min overdue (not waiting for a retry), failures in 24 h, approvals waiting over 24 h, Apply / Discard cards over 12 h, playbooks over 2 days, new ideas over 48 h.
  - `/app/health` page ("Network health" in Home of the menu), linked from the Overview "Network health" card.
  - `healthReportSection` renders the English text section; `GET /api/network-health/report` previews it.
  - Tests: `editor/health/network-health.049.test.ts`, `editor/health/network-health.pg.test.ts`.

## Deltas from the spec

- **MTProto sessions are not reconnected.** A second live connection with the same auth key risks `AUTH_KEY_DUPLICATED`. The keeper alerts on the `verify_error` the session code stores.
- **A failed Threads refresh is not marked as a broken connection.** A token under 24 hours old cannot be refreshed, and a network blip is not a dead account. The health check flags the token as `token_expiring` and then `token_invalid` as the expiry nears.
- **The Meta collector already verifies accounts every hour,** so the keeper only inspects token metadata for Facebook and Instagram.
- **The "daily summary of 012" does not exist.** The once-a-day reminder note stands in for it.
- **Slots are skipped, not paused.** A paused slot would wait for a fix that may never come, and the plan already shows a skip with its reason. Paused promo and reserved slots are unchanged.
- **Source health comes from the run trace, not a new table.** The trace keeps 30 days, so the window is 14 days and no migration is needed. A read that the trace truncated counts as a success with an unknown item count.
- **One 24-hour block does not ask for a replacement.** A blocked source needs a second block or 3 failed reads first.
- **Replacement asks are weekly.** The agent is asked at most once a week per source, and `SOURCE_PROPOSALS=off` turns the ask off (the tools stay).
- **No weekly owner report exists yet (it is 012's).** T5 ships the report section as `healthReportSection`; 012 puts it in the report.
- **The Chat menu counter changed (shipped with this work).** It and the new "Waiting for you" list (`GET /api/nav/attention`) count only cards that can still be applied, i.e. those under the 24-hour TTL.

## Owner actions after deploy

1. Reconnect both Threads accounts in `/app/connections`. Their tokens expired in August and cannot be refreshed. From then on the keeper keeps them fresh.
2. Keep `TOKEN_ENCRYPTION_KEY` set. Without it the keeper cannot store a refreshed token.
3. T3–T5 need no migration and no new settings.
