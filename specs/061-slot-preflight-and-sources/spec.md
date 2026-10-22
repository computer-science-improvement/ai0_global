# 061 — Slot pre-flight and sources

Status: draft · Builds on 023 (content ledger), 037 (stories, ledger canonical URLs), 046 FR-006 (dead sources), 049 (source health, keeper) · Migration 094

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

### FR-005 Fetch cache

`web_fetch` keeps a cache by canonical URL: `WEB_FETCH_CACHE_HOURS`, default 6, 0 = off. It is in memory, bounded (LRU about 200 entries), and holds successful results only. A cached result says `cached: true` and its fetch time. This cuts repeated law/page fetches inside and across runs.

### FR-006 Expired tokens stop the noise

- When verify or refresh fails with an expired-session error ("Session has expired", or Meta code 190 with subcode 463/467), set `token_expires_at = now()` on that account. The keeper then counts it `expired`, and health says «токен прострочено з <date>» with the date from the error text when it can be parsed.
- The Meta stats collector skips accounts whose last verify ended `token_invalid`/expired. It retries such an account once a day, not hourly, and logs one line a day, not one per hour.
- Note dedup is handled by 060 FR-003. Do not duplicate it here.

## Out of scope

Pausing whole series (060). Choosing new sources (owner).

## Acceptance

- Unit tests with fakes for the four pre-flight checks and the swap, the reusable-host ledger key, the error details, the idea settle outcomes, host strike escalation, the fetch cache, expired-token detection and collector backoff.
- PG tests for migration 094, ledger anchor uniqueness, `settleIdea` by outcome, and `source_host_failures` strikes.
- Fixture from review 3: 7 pdr slots on one URL with different clauses → 0 `source_already_posted`; same clause twice → blocked with details.

## Status

- T1 — this commit: migration 094 (`content_ledger.anchor`, `content_ledger_record_anchored`, `content_anchor_norm` / `content_ref_anchored`, `source_host_failures.strikes` / `noted_at` for T3), `LEDGER_REUSABLE_HOSTS`, reusable-host ledger key (`data/ledger-anchor.ts`, `ContentLedger`), `source.anchor` in the post spec and tool descriptions, `source_already_posted` with details and remedy, tests (unit + PG).

## Deltas from the spec

- **The anchor is part of the ledger ref, not a column in the unique index.** An anchored row is stored as `source_ref = <canonical url>#<anchor>` with the anchor also in a nullable `anchor` column (a CHECK ties them). The existing `UNIQUE (resource_ref, source_ref, status)` therefore already makes "the same clause once" unique, and every `ON CONFLICT (resource_ref, source_ref, status)` of 060 / 075 keeps working (a unique index including the anchor would have broken the 060 backfill and the 075 rewrite). `content_url_canonical` is untouched, so the canonical form of a URL does not change.
- **The anchor travels as the `#fragment` of the ref string** (`specRefs`, `sourceRefOf`), so every caller that already passes a ref (publish guards, approval re-check, shadow / publish recording) works without new parameters. Only hosts in `LEDGER_REUSABLE_HOSTS` act on it; elsewhere the fragment is dropped as before.
- **`content_ledger_record` is not changed.** A new `content_ledger_record_anchored` records the anchored form; a second overload with a defaulted argument made the 060 triggers ambiguous after a rerun of 060 (found by the 060 migration test).
- **Old plain rows of a reusable host stay and block nothing**: on a reusable host only a row with the same anchor blocks; a source without an anchor is allowed (as the spec says).
- **Migration 094 also holds the T3 columns** (`source_host_failures.strikes`, `noted_at`), so one migration number covers the spec.
- **`source_already_posted` details** come from the ledger verdict (`EditorPlansRepository.sourceVerdict`: status, time, slot id, anchor); a fake without that method falls back to the boolean answer with the generic remedy. The chat path keeps its English text and gets the anchor remedy.
