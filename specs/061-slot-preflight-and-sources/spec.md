# 061 — Slot pre-flight and sources

Status: done · Builds on 023 (content ledger), 037 (stories, ledger canonical URLs), 046 FR-006 (dead sources), 049 (source health, keeper) · Migration 094

## Why

Review 3 (`docs/reviews/2026-10-22-agent-review-3.md`, findings 2, 10–13) found that 54–62% of slot spend buys no post, and the executor and checker are paid to discover facts that code already knows:

- **One law, one source.** @pdr_dev_channel cites one URL (zakon.rada.gov.ua/laws/show/1306-2001-п) for every clause. The ledger blocks it after the first post. 10 executor runs ended on a bare `{"error":"source_already_posted"}` after 4–9 turns (`tools/role-tools.ts:134`; the chat path `chat/drafts.service.ts:201` already has details).
- **Stale and blocked sources.** Ideas 49–115 h old ran against 36/72 h thresholds, and slots ran on hosts already blocked. Blocked hosts are re-probed every 24 h forever: `net/host-failures.ts:13,113-118` resets `failures` to 1, so marktechpost.com had 109 calls in 14 days. Source health for @ai0_global shows `sources: []` because its feeds live in the playbook (`sources/source-health.ts:162-166`).
- **Ideas burned.** `settleIdea` (`network/network.repository.ts:386`) marks an idea `used` whatever the slot outcome: 22 of 41 `used` ideas ended skipped.
- **Dead tokens.** Two Threads tokens expired in August still produce 46 warnings a day and a daily critical card. The keeper counts `expired 0` because `token_expires_at` is empty or in the future (`config/connection-keeper.ts:97-103`), and the collector re-verifies every hour (`stats/meta-stats-collector.service.ts:80`).
- **Carousel without hosting.** A carousel was chosen while `SUPABASE_CAROUSEL_BUCKET` is unset (`publish/prepare-media.ts:68`), so the slot skipped.
- **Unreliable law site.** zakon.rada.gov.ua fails 14 of 31 fetches (timeouts of 13–22 s), and the same page is fetched again and again.

## What

### FR-001 Pre-flight before the executor (code, $0)

Before an executor run starts for a slot, check in code:

1. **Ledger.** The slot's source URL (from its idea, topic or `source_ref`) is in the content ledger for this channel, and the host is not reusable (FR-002).
2. **Freshness.** The idea's source is older than the channel's freshness threshold for a live/news slot. Use the same threshold the critic and audit use.
3. **Host block.** The source host is blocked in `source_host_failures`.
4. **Format.** The slot's format is carousel and carousel hosting is not configured. Generalise this as a `formatAvailable(format)` check.

If any check fails:

- Try **one swap**: take the next accepted idea of the same orchestrator that passes all four checks and fits the slot's series/format, re-topic the slot from it, and note `preflight_swap` on the slot.
- If no idea fits, skip the slot with code `preflight_<reason>` (`preflight_source_used`, `preflight_stale`, `preflight_host_blocked`, `preflight_format_unavailable`) and a Ukrainian reason line. No LLM call is made.
- These codes classify into the 060 cause classes: `no_material`, `source_unreachable`, or `infra` for format. Add them to `silent/skip-reasons.ts`.

### FR-002 Reference documents can be cited many times

- New setting `LEDGER_REUSABLE_HOSTS` (catalog, default `zakon.rada.gov.ua`, comma list) for reference documents.
- For a source on a reusable host, the URL-level ledger check is replaced by a key of URL plus anchor. The anchor is `source.anchor` (new optional field in the post spec, e.g. `п.1.10`, at most 40 chars) or the `#fragment` of the URL. The same clause is not posted twice; different clauses are allowed.
- Without an anchor, a reusable-host source is allowed. Story and topic dedup (spec 037) still applies.
- Migration 094 adds whatever the ledger needs to store the anchor. Prefer a nullable column and a unique index that includes it over changing canonical URLs; read `075`'s canonical URL logic first.
- The publish-time error `source_already_posted` (role tools) gets `details` and a remedy, as the chat path has: «джерело X уже використано <date> у слоті <id>; візьміть інше джерело або, для довідкового документа, вкажіть `source.anchor` (пункт)».
- The executor and orchestrator tool descriptions mention `source.anchor` for reference documents.

### FR-003 Ideas are not burned by skips

`settleIdea` marks `used` only when a slot of the idea was published. If the slot was skipped:

- `infra`, `budget`, `preflight_format_unavailable` or `series_paused`: back to `accepted` (it may be planned again).
- `no_material` or `source_unreachable`: `rejected`, with the reason in `review`.
- `critic`: unchanged. `rejectSoleSourceIdeas` already handles it.

### FR-004 Host blocks escalate; source health sees playbook feeds

- **Escalation.** Consecutive blocks of the same host escalate: 1 d → 3 d → 7 d (cap). Keep a `strikes` count that is not reset when a block expires; reset it only after a successful fetch. A timeout counts as a failure with a 1 h block (today only refusals do).
- **Playbook feeds.** Source health for a channel includes the playbook's feeds/sources of its orchestrator as well as the card's `sources`.
- **Owner card.** A host blocked 3 times in a row (≥ 7 d) raises **one** owner note and card, in Ukrainian, through the existing `change_source` proposal path (spec 049) when one exists, e.g. «marktechpost.com відмовляє нам 3 рази поспіль — прибрати з плейбука @ai0_global?».

### FR-005 Fetch cache (moved to spec 065)

> Moved to spec 065 (DocStore in `web_fetch`); not built here.

`web_fetch` keeps a cache by canonical URL: `WEB_FETCH_CACHE_HOURS`, default 6, 0 = off. It is in memory, bounded (LRU about 200 entries), and holds successful results only. A cached result says `cached: true` and its fetch time. This cuts repeated law/page fetches inside and across runs.

### FR-006 Expired tokens stop the noise

- When verify or refresh fails with an expired-session error ("Session has expired", or Meta code 190 with subcode 463/467), set `token_expires_at = now()` on that account. The keeper then counts it `expired`, and health says «токен прострочено з <date>» with the date from the error text when it can be parsed.
- The Meta stats collector skips accounts whose last verify ended `token_invalid`/expired. It retries such an account once a day, not hourly, and logs one line a day, not one per hour.
- Note dedup is handled by 060 FR-003. Do not duplicate it here.

## Out of scope

Pausing whole series (060). Choosing new sources (owner).

## Acceptance

- Unit tests with fakes for the four pre-flight checks and the swap, the reusable-host ledger key, the error details, the idea settle outcomes, host strike escalation, expired-token detection and collector backoff.
- PG tests for migration 094, ledger anchor uniqueness, `settleIdea` by outcome, and `source_host_failures` strikes.
- Fixture from review 3: 7 pdr slots on one URL with different clauses → 0 `source_already_posted`; same clause twice → blocked with details.

## Status

- T1 — this commit: migration 094 (`content_ledger.anchor`, `content_ledger_record_anchored`, `content_anchor_norm` / `content_ref_anchored`, `source_host_failures.strikes` / `noted_at` for T3), `LEDGER_REUSABLE_HOSTS`, reusable-host ledger key (`data/ledger-anchor.ts`, `ContentLedger`), `source.anchor` in the post spec and tool descriptions, `source_already_posted` with details and remedy, tests (unit + PG).
- T2 — this commit: `preflight/slot-preflight.ts` (ledger / freshness / host block / `formatAvailable`, one idea swap, `preflight_*` skip codes), wired into `runExecutor` before the writer; codes appended to `silent/skip-reasons.ts` (groups + `preflightCauseOf`); `settleIdea` by outcome (`network/idea-outcome.ts`), `claimIdea` / `releaseIdea`, `retopicSlot`; unit + PG tests.
- T3 — this commit: host strikes (`net/host-failures.ts`: `nextBlock`, `strikeHours`, `classifyTimeout`, `PgHostFailures.record` / `succeeded`), timeout as a one-hour failure in `fetchPageGuarded` and `fetch_feed`, `playbook-feeds.ts` (feeds the playbook names), source health over card + playbook feeds (`SourceHealthService.sourcesOf`, `origin`), `noteStruckHosts` (one owner Inbox note after 3 strikes, `noted_at`), the pre-flight ignores timeout blocks; unit + PG tests.
- T4 — this commit: `config/token-expiry.ts` (session-expired detection, date in the error, Ukrainian text), `MetaAccountsRepository.markTokenExpired`, `graphCodeSuffix` in the Graph client errors, keeper counts `metaExpired` / `threadsExpired`, collector daily backoff for expired accounts, health text «токен прострочено з <date>»; runbook § 20, specs README row 061 DONE; unit + PG tests.

## Deltas from the spec

- **The anchor is part of the ledger ref, not a column in the unique index.** An anchored row is stored as `source_ref = <canonical url>#<anchor>` with the anchor also in a nullable `anchor` column (a CHECK ties them). The existing `UNIQUE (resource_ref, source_ref, status)` therefore already makes "the same clause once" unique, and every `ON CONFLICT (resource_ref, source_ref, status)` of 060 / 075 keeps working (a unique index including the anchor would have broken the 060 backfill and the 075 rewrite). `content_url_canonical` is untouched, so the canonical form of a URL does not change.
- **The anchor travels as the `#fragment` of the ref string** (`specRefs`, `sourceRefOf`), so every caller that already passes a ref (publish guards, approval re-check, shadow / publish recording) works without new parameters. Only hosts in `LEDGER_REUSABLE_HOSTS` act on it; elsewhere the fragment is dropped as before.
- **`content_ledger_record` is not changed.** A new `content_ledger_record_anchored` records the anchored form; a second overload with a defaulted argument made the 060 triggers ambiguous after a rerun of 060 (found by the 060 migration test).
- **Old plain rows of a reusable host stay and block nothing**: on a reusable host only a row with the same anchor blocks; a source without an anchor is allowed (as the spec says).
- **Migration 094 also holds the T3 columns** (`source_host_failures.strikes`, `noted_at`), so one migration number covers the spec.
- **`source_already_posted` details** come from the ledger verdict (`EditorPlansRepository.sourceVerdict`: status, time, slot id, anchor); a fake without that method falls back to the boolean answer with the generic remedy. The chat path keeps its English text and gets the anchor remedy.
- **Pre-flight scope.** It runs for content slots the executor starts (`runExecutor`), not for reserved / promo slots, derived (duplicate / adapt) slots, live slots (their item is picked from the feeds; the live scan already skips an empty feed) or owner previews. Sources are the idea's `sources` plus the slot's `sourceHints`; only http(s) sources are judged (a library ref or free text lets the slot run), and one usable source is enough. When every source fails, the code reports spent, then stale, then blocked.
- **Freshness** uses the resource's own limit (`style.freshness_hours`, else news 36 h / games 72 h, evergreen / explainer / education exempt — `freshnessHoursOf`, the one the critic and the audit use). The source age is the day in a dated article URL, else the age of the idea.
- **Swap** keeps to ideas of the slot's orchestrator that are `accepted`, not expired, have a variant for the slot's resource and format, and pass all four checks; the newest first. A series slot, and a slot whose format is unavailable, are skipped, not swapped. The swap is stored by `EditorPlansRepository.retopicSlot` (idea, topic, angle, source hints) and the note `preflight_swap: …` is kept in the slot's `lint_warnings`; the idea the slot gave up is `rejected` with the reason in `review.slot_outcome`.
- **Format check** is `formatAvailable(format, env)`: any `*carousel*` format needs SUPABASE_URL, SUPABASE_SERVICE_KEY and SUPABASE_CAROUSEL_BUCKET (the same three the slide hosting reads); other formats are available.
- **Skip codes** are appended to `silent/skip-reasons.ts` as a block at the end (`RULES.push` for the groups and `preflightCauseOf` for the 060 cause class: `no_material`, `source_unreachable`, `infra`); the merge with spec 060's own classifier is a one-line change there.
- **`settleIdea` outcomes.** Out (published, shadowed, waiting for the owner) → `used`; infra / budget / `preflight_format_unavailable` / `series_paused` / a cap or a crashed run → `accepted`; no material (`preflight_*`, `no_fresh_item`, a blocked host) → `rejected` with `review.slot_outcome`; critic and content failures (lint, similarity) stay `used`, as before.
- **FR-005 moved to spec 065.** The `web_fetch` URL cache (`WEB_FETCH_CACHE_HOURS`) is not built here; spec 065 (DocStore in `web_fetch`) owns it and the `web_fetch` body in `read-tools.ts` is untouched by 061 (only `fetchPageGuarded` in `net/host-failures.ts`, which the tool already called, and the `fetch_feed` error branch changed).
- **Strikes.** `source_host_failures.strikes` (migration 094, backfilled from `failures`) counts blocks in a row: a refusal / DNS / TLS failure after the previous block ended is the next strike, one inside a block is the same strike; the block is 24 h, 72 h, then 168 h (the cap, also for the 4th and later strike). A fetch that works (`status < 400`) sets `strikes = 0` and clears `noted_at`. Feed failures (`feed_*`) stay a flat day on their own address and leave the strikes alone. `failures` keeps its old meaning (repeats inside one block).
- **Timeouts** (`ECONNABORTED`, `ETIMEDOUT`, undici timeouts, `TimeoutError`, "timeout of …ms exceeded") are recorded as reason `timeout`: a one-hour block, no strike, never shortening a longer block. `web_fetch` / `extract_images` (through `fetchPageGuarded`) and `fetch_feed` now answer `host_unreachable` instead of throwing. The pre-flight does not count a `timeout` block as `preflight_host_blocked` (it would burn the idea), and source health does not ask for a replacement for it.
- **Playbook feeds.** The playbook has no source list of its own; the feeds it reads are the http(s) addresses its active series name (`source: { kind: 'feed', ref: <url> }`) and the links in its `rules`. `playbookSources` turns those (minus hosts / feed addresses the card already has) into sources with the id `playbook:<host>`, kind `rss` for a feed-like address, else `url`. They are listed by `get_source_health` and the dashboard with `origin: 'playbook'`. They are not offered to the channel agent for a card replacement (`change_source` edits the card only). The orchestrator is the one whose scope is the channel's `telegram:<key>` resource.
- **The owner card after 3 strikes** is an Inbox note with severity `action` (it shows in "Waiting for you" and in the owner bot), in Ukrainian: «marktechpost.com відмовляє нам 3 рази поспіль — прибрати з плейбука @ai0_global?». It is written by `SourceHealthService.noteStruckHosts` from the orchestrator's daily run (`toReplaceToday`), once per streak (`noted_at`, claimed with `UPDATE … WHERE noted_at IS NULL`; a success starts the next streak). It is a note, not a `change_source` Apply card: for a source on the card the existing 049 flow already asks the agent for a replacement (a second strike now counts as "blocked again and again") and the Apply / Discard card comes from there; a playbook feed cannot be removed by `change_source`, so the note tells the owner to remove it (directive to the MANAGER). `noted_at` is per host: when two channels read the same host, the first channel's daily run gets the note.
- **Expired tokens.** Detection is by text (`Session has expired`, or code 190 with subcode 463 / 467); the Graph client now appends ` (code 190, subcode N)` to its verify / refresh errors for code-190 errors only, so the subcode test can work on the text the callers already have. `markTokenExpired` sets `token_expires_at` (the date in the error with its zone, else now), `token_valid = false`, `verify_error = «токен прострочено з <date> — перепідключіть акаунт у /app/connections»` and the verify time. Callers: the hourly collector, the `POST /meta-accounts/:id/verify` endpoint, and the keeper (a Threads refresh that fails with an expired session, or Facebook / Instagram upkeep that throws one). The health text of an account marked this way is that Ukrainian line; an expiry that only came from `debug_token` keeps its English `token expired on <date>` (the dashboard and its tests read it). The keeper counts them in `threadsExpired` and a new `metaExpired`.
- **Collector backoff.** An account is "expired" when its verify error is the line above or its stored expiry has passed; such an account is skipped while its last verify (the mark counts) is under 24 h old, so it is asked once a day and logs one line a day. Any other verify failure (wrong target, network) is retried hourly as before. The reconnect flow (good verify and the new expiry from `debug_token`) clears the state.
