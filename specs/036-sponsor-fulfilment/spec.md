# 036: Paid digest sponsors are never silently lost

**Status:** DONE (built 2026-10-10) · **Priority:** P0 (money) · **Depends on:** 008 (revenue path), 023 (strategy → series
migration, cutover), 025 (pauses), 031 (approval mode) · **Migration:** `072_sponsor_fulfilment.sql`

## Why
A paid `digest_sponsor` order (the "Партнер дайджесту" line inside a daily digest) was published only by the legacy digest
strategies. After a spec 023 cutover retires a channel's digest binding and the agent runs the channel through series, nothing
publishes the sponsor: the advertiser paid, the order stays `paid` / `scheduled` forever and nobody is told. Found while refreshing
BRD 08 (`docs/brd/08-marketing-ads-reports.md`, BR-MKT-24 and the «Спостереження» of §3.2).

## As-is (base `d8746a2`)
- Formats: `ad_prices.format ∈ post | pin_24h | digest_sponsor` (`database/migrations/044_ad_revenue.sql:11`).
- `post` / `pin_24h`: owner clicks Schedule → `AdOrdersService.schedulePost` (`payments/ad-orders.service.ts:94`) → pending
  `schedule_post` action → on approval `AdPlacement.place` (`agent/ad-placement.ts:50`) reserves an editor slot (`:67`) or falls
  back to `scheduled_posts` (`:80`). The reserved lane (`EditorScheduler.reservedTick`, `editor/editor.scheduler.ts:117` →
  `ReservedDispatcher.publishDue`, `editor/publish/reserved-dispatcher.ts:33` → `SponsoredPublisher.publishSlot`,
  `editor/publish/sponsored.publisher.ts:70`) publishes deterministically with the code-added `#реклама`, outside approval mode
  and resource pauses. No legacy strategy involved.
- `digest_sponsor`: no slot, no action. `DigestSponsorsRepository.findForDay` (`payments/digest-sponsors.repository.ts:34`) is
  called only by `NetworkDigestStrategy` (`strategies/network-digest/network-digest.strategy.ts:124`, marked published `:153`) and
  `TopicDigestStrategy` (`strategies/topic-digest/topic-digest.strategy.ts:158`, `:185`), which render the line with `#реклама`
  (`common/digests/digest-format.ts:133`). The digest also silently skips an order without a link (`sponsorFromOrder`) or when it
  does not run that day (too few items).
- Spec 023 maps `network-digest` / `topic-digest` to a `network_highlights` series (`editor/migration/type-mapping.ts:109,113`);
  the cutover retires the binding (`editor/migration/strategy-migration.service.ts:272`, `:289`). The series has no sponsor slot.
- The price list still offered the format everywhere: `/api/landing/prices` (`payments/ads-public.controller.ts:26`), the media kit
  (`payments/ad-prices.repository.ts:71`), the DM price-list draft (`agent/agent-inbox.poller.ts:70`).
- `schedulePost` did not refuse a `digest_sponsor` order (only the UI hid the button), so one order could go out twice (a manual
  slot and the digest line); `SponsoredPublisher` only skipped `canceled` orders.

**Strategy-dependent paid order types:** only `digest_sponsor` (both digest strategies). `post` / `pin_24h` / custom orders go
through `AdPlacement` (reserved slot or `scheduled_posts`) and never depend on a strategy. Related non-order revenue that also died
with the binding: the static `params.sponsor` of a digest binding (an owner-configured sponsor outside `ad_orders`).

## Design (chosen)
Option (b) of the brief + the guard (c). The agent's digest is an LLM post that waits for the owner in approval mode and is held by
pauses, so embedding a paid line in it (option a) would let approval / pauses / a rejected digest swallow a contractual ad. Instead:

1. **Fulfilment** — while an enabled `network-digest` / `topic-digest` binding publishes to the order's channel, nothing changes
   (the strategy embeds the line). Otherwise the order is placed in the **reserved lane** as a standalone sponsored post: same
   creative, link with the ai0 UTM tags, `#реклама` (+ «Реклама. Замовник: …»), deterministic, no LLM, ignores approval mode and
   pauses (unchanged rule). Time: 10 min after the agent's first digest-like series instance (source `network_highlights`) on the
   order's day; else the order's own time moved out of the card's quiet hours; a passed time → as soon as possible the same day.
2. **Sale guard** — a `digest_sponsor` price is *sellable* only while a digest strategy runs on its channel. Unsellable prices are
   hidden from the landing price list, the media kit, the landing networks "advertise" flag and the DM price list; creating an
   order on such a price, or saving such a price, is refused (400). `schedulePost` refuses `digest_sponsor` orders.
3. **Flags** — an order that cannot be placed is flagged once per reason (`ad_orders.flag_reason`) with an Inbox action + admin-bot
   alert; the cutover reports all open digest sponsors, the static sponsors and the hidden prices of the retired channels.
4. **Stuck-order check** — at startup and daily: paid/scheduled orders with no path to publication are flagged once and posted in
   one Inbox action; a read-only CLI lists them. Nothing is refunded or published automatically; old orders are never auto-published.

## FRs as built
- **FR-001 Repository** `payments/sponsor-orders.repository.ts`: `digestRunsOnSql` / `sellablePriceSql` predicates,
  `openDigestSponsors` (channel resolved from key or `tracked_channels` uuid), `digestSponsorsOn`, `digestSponsorPricesOn`,
  `digestRunsOn`, `digestCadences` (active playbooks' `network_highlights` series on `telegram:<key>`), guarded `place`
  (status → `scheduled`, slot linked, flag cleared, never twice), `dropSlot`, `flag` (true only for a new reason), `openOrders`.
- **FR-002 Fulfilment** `payments/sponsor-fulfilment.ts`: `sponsorCreative` (UTM on CTA and buttons), pure `sponsorPostTime`,
  `SponsorFulfilment.assess / reserveDue / reportCutover`. Flag reasons: `no_channel`, `no_publish_date`, `no_creative`, `no_link`
  (also checked while the legacy digest runs — it would skip them silently), `no_agent_card`, `creative_invalid`, `missed_day`.
  Orders are placed at most 48 h ahead; a past day is left to FR-005. Slot hints `ad_order:<id>`, `digest_sponsor`.
- **FR-003 Reserved lane** (`editor/editor.module.ts`): every minute `reserveDue` runs before `ReservedDispatcher.publishDue`
  (its failure never blocks the lane). `SponsoredPublisher` now also skips orders already `published` / `reported` (no double post)
  and tells the owner a digest sponsor went out as a standalone post. `DigestSponsorsRepository.findForDay` ignores placed orders.
- **FR-004 Sale guard**: `AdPricesRepository.list({sellableOnly})` and rows carry `sellable`; media kit and landing networks filter;
  `AdOrdersService.create` and `PUT /api/ad-prices` refuse `digest_sponsor` where no digest runs; `schedulePost` refuses
  `digest_sponsor`. Dashboard `/app/ads`: «not offered» badge on the price, unsellable prices left out of the New order select,
  «needs attention: …» badge on flagged orders, accurate hints for digest sponsors and reserved slots.
- **FR-005 Cutover** (`StrategyMigrationService.cutover` → `reportSponsors`): after the transaction, for the retired digest bindings
  one Inbox action (`sponsor_cutover`, + alert) lists each open order (sold or paid) and its fate, flags the unfulfillable ones, lists
  static sponsors and prices no longer offered. Never blocks the cutover.
- **FR-006 Stuck orders** `payments/stuck-ad-orders.ts` + `stuck-ad-orders.upkeep.ts` (startup + 90 s, cron `27 9 * * *`,
  `AD_STUCK_CHECK=off` disables): reasons `no_publish_date`, `day_passed` (digest sponsor, Kyiv day over, unplaced), `slot_failed`,
  `not_scheduled` (paid, time passed > 24 h, never scheduled), `approval_pending` (action pending/rejected/failed, time passed).
  One Inbox action `ad_orders_stuck` for the new ones. CLI: `npm run ads:stuck-orders [-- --json]` / `node dist/cli/stuck-ad-orders.js`
  (read-only session, exit 1 when something is stuck).
- **FR-007 Migration 072**: `ad_orders.flag_reason`, `flagged_at`, partial index on open orders; guarded, idempotent.
- Accounting unchanged: `paid_at` and `channel_id` are never rewritten, so the KPI revenue by day in the resource time zone counts
  the order exactly as before; the post is a `published_posts` row with `strategy_type='ad'`, tag `реклама`, report token issued, so
  the 24 / 72 h advertiser reports work (link with UTM, as for the digest line).

## Tests
`payments/sponsor-fulfilment.test.ts` (timing, UTM, placement, flags once, legacy untouched, past/far days, race, cutover report, end
to end through `ReservedDispatcher` + `SponsoredPublisher` with a fake publisher under approval mode and a pause),
`payments/stuck-ad-orders.test.ts`, additions to `sponsored.publisher.test.ts`, `ad-orders.service.test.ts`,
`ad-orders.controller.test.ts`; PG: `payments/sponsor-fulfilment.pg.test.ts` (legacy → cutover report → hidden price → refused sale
→ placement after the series → published via the reserved lane → stuck check) and the media-kit case in `ad-revenue.pg.test.ts`.

## Owner to-dos
- Run `node dist/cli/stuck-ad-orders.js` on stage and prod after deploy (or read the `ad_orders_stuck` Inbox item the service posts
  ~90 s after start) and settle each listed order with its advertiser (publish by hand, move the date, or refund in LiqPay).
- Before the next digest cutover: tell advertisers with future digest-sponsor orders that the sponsor will be a standalone post
  marked #реклама (the cutover Inbox item lists them).
- Decide whether to sell a new "agent digest sponsor" product (a sponsor block inside the agent's digest — needs a rule for approval
  mode and pauses) and whether to re-add static sponsors as orders.
- Known, unchanged (BRD 08): mixed `ad_orders.channel_id` formats (uuid vs key) still miss the MANAGER KPI revenue join; no
  cancel/refund status.
