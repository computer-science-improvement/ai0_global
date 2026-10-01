# 008: Revenue path

**Status:** DONE (T007 partial) · **Depends on:** 001 (LiqPay callback reachable), 005 (editor reserves slots)

## Why
Payments work, but the commercial wrapper is missing:
- no price list
- no legal ad label
- no creative (image or button)
- no link from order → post → stats
- no advertiser report

The audience is small (~9.4k), so every sale has to look professional.

## Requirements and tasks
- [x] T001 **Price list:**
  - `ad_prices` table: channel, format, price_uah, active.
  - A public `GET /api/landing/prices`.
  - An `ad_orders.price_id` FK; the amount is computed server-side.
- [x] T002 **Ad creative:**
  - Add `creative` JSONB to `ad_orders`, as a PostSpec subset (004): body, media, CTA button.
  - Sponsored posts render through `renderTelegram` with a mandatory `#реклама` line added by code, never by the model.
- [x] T003 **Reserved slots:**
  - A paid order creates an `editor_slots` row with `kind='reserved'` at the agreed time.
  - The planner (005) sees reserved slots as fixed and plans around them.
  - Reserved slots publish deterministically, without the LLM, through the same guarded publisher.
- [x] T004 **Order lifecycle:**
  - Statuses `scheduled → published (post_id) → reported`.
  - `ad_orders.published_post_id` FK to `published_posts`.
- [x] T005 **Advertiser report:**
  - A job at +24 h and +72 h after publish builds a report: views, forwards, reactions, CTR proxy if UTM.
  - The output is an HTML page (public tokenized URL), plus a draft DM to the advertiser as an SP2 `agent_actions` row (owner approves the send).
- [x] T006 **Digest sponsor slot:** sponsors come from paid `ad_orders` (format `digest_sponsor`) instead of a static param; the URL renders as a link with UTM.
- [~] T007 **Sales agent tooling** (semi-autonomous; principle II plus human approval):
  - [x] The triage agent replies to `ad_offer` DMs with a price-list template, as a pending action.
  - [~] It drafts an invoice and creates the `ad_order` in `draft`. *Not automated:* the DM rarely pins down
    channel, format and date, and a wrong draft invoice is worse than none. The owner creates the order on
    `/app/ads` (price → amount is computed); `ad_orders.thread_id` links it to the DM thread so the report
    DM goes to the right person.
  - [x] The owner approves. Caps: `AGENT_REPLY_DAILY_CAP`.
- [x] T008 **Media kit page** on the landing site: live stats (latest subscribers from `channel_stats_snapshots`,
  the same source as `editor_v_channel_daily`, plus avg views per post over 30 days), plus the prices.

## Implementation notes (2026-10-01)

**Migration `044_ad_revenue.sql`** (additive, idempotent, records its version):
`ad_prices(id, channel_key, format ∈ post|pin_24h|digest_sponsor, price_uah > 0, active, note, created_at)`
with a partial unique index on `(channel_key, format) WHERE active`. `ad_orders` gains nullable
`price_id → ad_prices`, `creative jsonb`, `sponsor_label`, `publish_at`, `editor_slot_id`,
`published_post_id → published_posts`, `thread_id → agent_dm_threads`, `report jsonb`, `reported_at`,
`report_token` (unique). The status CHECK is widened with `published` and `reported` (DO block, only when missing).

**Creative (T002)** `editor/post/sponsored.ts`: `SponsoredCreativeSchema` is a strict PostSpec subset
(`format` text|photo, `body`, ≤ 1 `media`, `placement`, `cta`, `buttons`; hashtags, source and library_ref are
rejected). `renderSponsored(creative, card, order)` renders through `renderTelegram` with a sponsored card
variant whose footer is `Реклама. Замовник: <sponsor_label>` (optional) and then `#реклама` as the last line.
`lintSponsored` reuses `lintPost` without hashtag/format-weight rules; banned terms, language and emoji become
warnings (advertiser wording), media count, body, lengths and URLs stay errors.

**Placement (T003)** — the SP2 approval gate is unchanged: `paid` order → `POST /api/ad-orders/:id/schedule`
→ pending `schedule_post` action (payload has `orderId`) → owner approves → `AdPlacement`:
1. `EDITOR_ENABLED=true` and the channel has an `editor_channels` card (any mode) → reserved slot in the day's
   active plan (a plan with rationale `reserved only` is created when the day has none; the scheduler still runs
   the planner for that day and `createPlan` moves reserved slots into the real plan).
2. Otherwise → SP2 `scheduled_publications` with the rendered creative (incl. `#реклама`). The order stays
   `scheduled` on this path (no automatic post link or report).

`EditorScheduler.cronTick` runs `SponsoredPublisher.publishDue` on every tick **even when `EDITOR_ENABLED` is
false** and regardless of the channel's editor mode. It honours `publish_paused`, never posts more than 6 h
late, never retries a failed send, and inserts `published_posts` with `strategy_type='ad'`.

**Reports (T005)** `AdReportsService` (cron `17 * * * *`): ≥ 24 h → stage `24h`, ≥ 72 h → stage `72h` and
status `reported`. Public JSON at `GET /api/ads/report/:token`, page at `/report/$token`. The first report drafts a
pending `reply` action (no new action type, so the `agent_actions` CHECK is untouched) when the order has a
`thread_id`; otherwise the owner gets the link from the admin bot.
